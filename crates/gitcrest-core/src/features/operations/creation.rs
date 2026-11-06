use super::{
    actions::{ActionSubmission, ActionSubmitError, OperationActionService},
    preview::{CheckoutPreviewInput, CheckoutTargetRequest, PreviewError},
};
use crate::{
    domain::{
        operation::{GitOperation, NewOperation, OperationCommand, OperationRequest},
        operation_action::{OperationActionKind, OperationActionRequest},
        request_access::RequestAccess,
    },
    execution::TaskService,
    ports::operations::OperationStoreError,
};
use sha2::{Digest, Sha256};

#[cfg(test)]
mod tests;

const INITIAL_ACTION: &str = "initial-preserved-checkout";
// OperationStorePort registers a new operation at version 1. Retries must keep
// this request body even after the operation advances or becomes unknown.
const INITIAL_VERSION: i64 = 1;

#[derive(Clone)]
pub(crate) struct OperationCreationService {
    pub actions: OperationActionService,
}

pub(crate) struct CreationReceipt {
    pub operation_id: String,
    /// Registration is durable even if dispatch fails. Read the current view
    /// using the operation ID or original creation request ID; do not fabricate
    /// a snapshot by combining this receipt with a newer task status.
    pub dispatch: Result<ActionSubmission, ActionSubmitError>,
}

#[derive(Debug)]
pub(crate) enum CreationError {
    Forbidden,
    InvalidRequest,
    ShuttingDown,
    Store(OperationStoreError),
    Preview(PreviewError),
    PreviewStale,
    UnsupportedPath,
}

impl OperationCreationService {
    /// Internal application entry for a reviewed checkout lease. Public HTTP
    /// creation remains closed until all recovery paths and the API contract
    /// are available. No caller-selected operation ID or resource key is used.
    pub async fn create(
        &self,
        tasks: &TaskService,
        access: RequestAccess,
        repo_id: &str,
        request_id: &str,
        request: OperationRequest,
    ) -> Result<CreationReceipt, CreationError> {
        if !access.allows_operation_actions() {
            return Err(CreationError::Forbidden);
        }
        if repo_id.trim().is_empty()
            || request_id.trim().is_empty()
            || request_id.len() > 128
            || request_id.chars().any(char::is_control)
        {
            return Err(CreationError::InvalidRequest);
        }
        let service = self.clone();
        let tasks_for_job = tasks.clone();
        let repo_id = repo_id.to_owned();
        let request_id = request_id.to_owned();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        if !tasks.spawn_background(async move {
            let result = service
                .create_tracked(&tasks_for_job, &repo_id, &request_id, request)
                .await;
            let _ = sender.send(result);
        }) {
            return Err(CreationError::ShuttingDown);
        }
        receiver
            .await
            .map_err(|_| CreationError::Store(OperationStoreError::Unavailable))?
    }

    async fn create_tracked(
        &self,
        tasks: &TaskService,
        repo_id: &str,
        request_id: &str,
        request: OperationRequest,
    ) -> Result<CreationReceipt, CreationError> {
        let access = tasks
            .write_access()
            .ok_or(CreationError::Store(OperationStoreError::Unavailable))?;
        let fingerprint = request.fingerprint();
        let operation = match self.lookup(repo_id, request_id).await? {
            Some(operation) => operation,
            None => match self.review(repo_id, &request).await {
                Ok(()) => access
                    .claim(NewOperation {
                        operation_id: operation_id(repo_id, request_id),
                        repo_id: repo_id.into(),
                        resource_key: "derived-by-write-access".into(),
                        request_id: request_id.into(),
                        request,
                    })
                    .await
                    .map_err(CreationError::Store)?,
                // Another same-key creator may have committed and started Git
                // while this read-only preview was running. Its durable receipt
                // takes precedence over the now-stale source preview.
                Err(error) => self.lookup(repo_id, request_id).await?.ok_or(error)?,
            },
        };
        if operation.request.fingerprint() != fingerprint {
            return Err(CreationError::Store(OperationStoreError::RequestConflict));
        }
        // The claim permit is already released. Dispatch only queues a child
        // worker; no task holding the common-dir lock waits for another task.
        let dispatch = self
            .actions
            .submit_tracked(
                tasks,
                repo_id,
                &operation.operation_id,
                OperationActionRequest {
                    request_id: INITIAL_ACTION.into(),
                    expected_version: INITIAL_VERSION,
                    kind: OperationActionKind::StartPreservedCheckout,
                },
            )
            .await;
        Ok(CreationReceipt {
            operation_id: operation.operation_id,
            dispatch,
        })
    }

    async fn lookup(
        &self,
        repo_id: &str,
        request_id: &str,
    ) -> Result<Option<GitOperation>, CreationError> {
        let store = self.actions.restore.checkout.saves.operations.clone();
        let repo = repo_id.to_owned();
        let key = request_id.to_owned();
        let existing = tokio::task::spawn_blocking(move || {
            let existing = store.operation_request(&repo, &key)?;
            if existing.is_none() {
                if let Some(operation_id) = store.repository_operation_owner(&repo)? {
                    // Registration may have committed between the two reads.
                    if let Some(existing) = store.operation_request(&repo, &key)? {
                        return Ok(Some(existing));
                    }
                    return Err(OperationStoreError::ResourceOwned { operation_id });
                }
            }
            Ok(existing)
        })
        .await
        .map_err(|_| CreationError::Store(OperationStoreError::Unavailable))?
        .map_err(CreationError::Store)?;
        Ok(existing)
    }

    async fn review(&self, repo_id: &str, request: &OperationRequest) -> Result<(), CreationError> {
        let target = match &request.command {
            OperationCommand::CheckoutBranch { name, .. } => {
                CheckoutTargetRequest::LocalBranch(name.clone())
            }
            OperationCommand::CheckoutDetached { target_oid } => {
                CheckoutTargetRequest::Commit(target_oid.clone())
            }
            _ => return Err(CreationError::UnsupportedPath),
        };
        let checkout = &self.actions.restore.checkout;
        let preview = checkout
            .saves
            .preview_checkout(
                repo_id,
                checkout.branches.as_ref(),
                CheckoutPreviewInput {
                    target: &target,
                    preservation: request.preservation,
                    shelf_name: "Before checkout",
                    shelf_description: "",
                },
            )
            .await
            .map_err(CreationError::Preview)?;
        if preview.target.operation_command() != request.command
            || Some(&preview.source_head) != request.source_head_oid.as_ref()
            || preview.source_branch != request.source_branch
        {
            return Err(CreationError::PreviewStale);
        }
        let plan = preview.preservation.ok_or(CreationError::UnsupportedPath)?;
        if plan.before.fingerprint() != request.changes_fingerprint {
            return Err(CreationError::PreviewStale);
        }
        Ok(())
    }
}

fn operation_id(repo_id: &str, request_id: &str) -> String {
    let identity = serde_json::to_vec(&("preserved-checkout-v1", repo_id, request_id))
        .expect("typed creation identity serializes");
    format!("operation-{:x}", Sha256::digest(identity))
}
