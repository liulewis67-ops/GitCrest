use super::{
    checkout::OperationCheckoutService,
    pull_preview::{self, PullPreview, PullPreviewInput},
};
use crate::{
    domain::{
        git_result::GitFailureCode,
        operation::*,
        operation_action::OperationActionKind,
        remote::{RemotePullCommand, RemotePullStrategy},
    },
    execution::{TaskContext, TaskFailure},
    features::{remotes::pull, shelves::evidence},
    git::remote::GitRemoteAdapter,
    ports::remotes::RemoteGitPort,
};
use std::path::Path;

impl OperationCheckoutService {
    pub(super) async fn review_pull_registration(
        &self,
        repo: &str,
        request: &OperationRequest,
    ) -> Result<(), TaskFailure> {
        let (_, _, _, target) = pull_request(request)?;
        let location = self
            .saves
            .targets
            .task_target(repo)
            .await
            .map_err(|_| changed("The Pull repository is unavailable."))?;
        self.review_pull_source(repo, request, &location.repository_path, target)
            .await?;
        Ok(())
    }

    pub(super) async fn prepare_pull(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        authorize(&operation, context, OperationActionKind::PreparePull)?;
        let result = self.fetch_and_review(&mut operation, context).await;
        match result {
            Ok(()) => Ok(operation),
            Err(error) => {
                let uncertain = operation
                    .pull_fetch_step()
                    .filter(|step| step.status == OperationStepStatus::IntentRecorded)
                    .map(|step| OperationStep {
                        status: OperationStepStatus::Unknown,
                        failure_code: Some(GitFailureCode::OutcomeUnknown),
                        ..step.clone()
                    });
                let mut state = operation.state.clone();
                state.status = OperationStatus::RecoveryRequired;
                (state.wait_reason, state.failure_code) = if uncertain.is_some() {
                    (
                        Some(OperationWaitReason::OutcomeUnknown),
                        Some(GitFailureCode::OutcomeUnknown),
                    )
                } else {
                    (
                        Some(OperationWaitReason::ExternalChange),
                        Some(GitFailureCode::PreconditionChanged),
                    )
                };
                self.record(&mut operation, state, uncertain).await?;
                Err(error)
            }
        }
    }

    async fn fetch_and_review(
        &self,
        operation: &mut GitOperation,
        context: &TaskContext,
    ) -> Result<(), TaskFailure> {
        let (_, _, _, expected) = pull_request(&operation.request)?;
        let expected = expected.to_owned();
        let target = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The Pull repository is unavailable."))?;
        let path = &target.repository_path;
        let reference = operation.pull_fetch_ref();
        self.location(operation, path).await?;
        self.review_pull_source(&operation.repo_id, &operation.request, path, &expected)
            .await?;
        if self
            .saves
            .commands
            .read_pull_fetch_ref(path, &reference)
            .await?
            .is_some()
        {
            return Err(changed("A Pull fetch reference already exists."));
        }
        check_cancel(context)?;
        let mut step = OperationStep {
            sequence: 0,
            kind: OperationStepKind::Fetch,
            status: OperationStepStatus::Planned,
            input_fingerprint: operation.pull_fetch_input(),
            before_fingerprint: Some(operation.request.changes_fingerprint.clone()),
            after_fingerprint: None,
            task_id: Some(context.task_id().into()),
            backup_id: None,
            failure_code: None,
            source_objects: None,
            source_recovery_outcome: None,
        };
        let state = preparing();
        self.record(operation, state.clone(), Some(step.clone()))
            .await?;
        let command = self
            .review_pull_source(&operation.repo_id, &operation.request, path, &expected)
            .await?;
        self.location(operation, path).await?;
        if self
            .saves
            .commands
            .read_pull_fetch_ref(path, &reference)
            .await?
            .is_some()
        {
            return Err(changed("The Pull fetch reference appeared after planning."));
        }
        check_cancel(context)?;
        step.status = OperationStepStatus::IntentRecorded;
        self.record(operation, state, Some(step)).await?;
        check_cancel(context)?;
        self.saves
            .commands
            .fetch_pull_target(path, &command, &reference, context.clone())
            .await?;
        self.confirm_pull_fetch(operation, path, context).await?;
        self.review_fetched_pull(operation).await?;
        Ok(())
    }

    pub(super) async fn reconcile_pull_fetch(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        authorize(&operation, context, OperationActionKind::ReconcilePullFetch)?;
        let target = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The Pull repository is unavailable."))?;
        self.confirm_pull_fetch(&mut operation, &target.repository_path, context)
            .await?;
        Ok(operation)
    }

    async fn confirm_pull_fetch(
        &self,
        operation: &mut GitOperation,
        path: &Path,
        context: &TaskContext,
    ) -> Result<(), TaskFailure> {
        let (_, remote, branch, _) = pull_request(&operation.request)?;
        let mut step = operation
            .pull_fetch_step()
            .cloned()
            .filter(|step| {
                matches!(
                    step.status,
                    OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
                )
            })
            .ok_or_else(|| changed("There is no unresolved Pull fetch intent."))?;
        let reference = operation.pull_fetch_ref();
        self.location(operation, path).await?;
        let read = || async {
            let oid = self
                .saves
                .commands
                .read_pull_fetch_ref(path, &reference)
                .await?
                .ok_or_else(|| unknown("The Pull fetch has no protected target to verify."))?;
            let tracking = GitRemoteAdapter
                .resolve_tracking_commit(path, remote, branch)
                .await
                .map_err(|_| unknown("The fetched tracking branch could not be read."))?;
            if tracking.as_deref() != Some(oid.as_str()) {
                return Err(unknown(
                    "The protected Pull target and tracking branch disagree.",
                ));
            }
            Ok(oid)
        };
        let oid = read().await?;
        if read().await? != oid {
            return Err(unknown(
                "The fetched Pull target changed during verification.",
            ));
        }
        self.location(operation, path).await?;
        check_cancel(context)?;
        step.status = OperationStepStatus::Verified;
        step.after_fingerprint = Some(oid);
        step.failure_code = None;
        self.record(operation, preparing(), Some(step)).await
    }

    pub(super) async fn record_fetched_pull_review(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.load(id).await?;
        authorize(&operation, context, OperationActionKind::ReviewFetchedPull)?;
        let preview = self.review_fetched_pull(&operation).await?;
        let plan = preview
            .preservation
            .as_ref()
            .map(|plan| plan.to_operation_plan(context.task_id()))
            .transpose()?;
        check_cancel(context)?;
        let store = self.saves.operations.clone();
        let id = operation.operation_id;
        let task = context.task_id().to_owned();
        tokio::task::spawn_blocking(move || {
            store.record_pull_review(&id, operation.version, &task, plan)
        })
        .await
        .map_err(|_| unknown("The Pull review could not be confirmed."))?
        .map_err(|_| unknown("The Pull review could not be persisted."))
    }

    /// Replan against the protected result of the completed Fetch. The caller
    /// must still hold an owner permit before acting on this read-only preview.
    pub(super) async fn review_fetched_pull(
        &self,
        operation: &GitOperation,
    ) -> Result<PullPreview, TaskFailure> {
        let (strategy, _, _, _) = pull_request(&operation.request)?;
        let fetched = operation
            .verified_pull_target()
            .ok_or_else(|| changed("The Pull target has not been fetched and verified."))?;
        let target = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The Pull repository is unavailable."))?;
        let path = &target.repository_path;
        let reference = operation.pull_fetch_ref();
        self.location(operation, path).await?;
        let expected = self
            .review_pull_source(&operation.repo_id, &operation.request, path, fetched)
            .await?;
        let preview = pull_preview::read_pull(
            &self.saves.commands,
            self.saves.worktree.as_ref(),
            self.branches.as_ref(),
            &GitRemoteAdapter,
            &operation.repo_id,
            path,
            PullPreviewInput {
                strategy,
                preservation: operation.request.preservation,
                shelf_name: "Before Pull",
                shelf_description: "",
            },
        )
        .await
        .map_err(|_| changed("The fetched Pull protection plan could not be reviewed."))?;
        if preview.command != expected
            || self
                .saves
                .commands
                .read_pull_fetch_ref(path, &reference)
                .await?
                .as_deref()
                != Some(fetched)
        {
            return Err(changed(
                "The protected Pull target changed during planning.",
            ));
        }
        self.verify_pull_source(&operation.repo_id, &operation.request, path)
            .await?;
        self.location(operation, path).await?;
        if operation.steps.len() > 1 || operation.preservation_plan.is_some() {
            let task = operation
                .pull_review_step()
                .and_then(|step| step.task_id.as_deref())
                .ok_or_else(|| changed("The recorded Pull review is invalid."))?;
            let current_plan = preview
                .preservation
                .as_ref()
                .map(|plan| plan.to_operation_plan(task))
                .transpose()?;
            if current_plan != operation.preservation_plan {
                return Err(changed("The recorded Pull protection plan changed."));
            }
        }
        Ok(preview)
    }

    async fn review_pull_source(
        &self,
        repo: &str,
        request: &OperationRequest,
        path: &Path,
        target_oid: &str,
    ) -> Result<RemotePullCommand, TaskFailure> {
        let (_, remote, branch, _) = pull_request(request)?;
        self.verify_pull_source(repo, request, path).await?;
        let preview = pull::read_pull_preflight(
            repo.into(),
            path,
            request.source_branch.as_deref(),
            false,
            self.branches.as_ref(),
            &self.saves.commands,
            &GitRemoteAdapter,
        )
        .await
        .map_err(|_| changed("The Pull upstream could not be verified."))?;
        if preview.has_conflicts
            || preview.operation_in_progress
            || Some(preview.local_oid.as_str()) != request.source_head_oid.as_deref()
            || preview.remote_name != remote
            || preview.remote_branch != branch
            || preview.tracking_oid != target_oid
        {
            return Err(changed("The Pull source or upstream changed."));
        }
        Ok(RemotePullCommand::from(&preview))
    }

    async fn verify_pull_source(
        &self,
        repo: &str,
        request: &OperationRequest,
        path: &Path,
    ) -> Result<(), TaskFailure> {
        let source = evidence::read_carry_snapshot(
            &self.saves.commands,
            self.saves.worktree.as_ref(),
            repo,
            path,
        )
        .await
        .map_err(|_| changed("The Pull source changes cannot be verified."))?;
        if !source.matches_source(
            request.source_head_oid.as_deref(),
            request.source_branch.as_deref(),
        ) || source.fingerprint() != request.changes_fingerprint
        {
            return Err(changed("The local Pull source changed."));
        }
        Ok(())
    }
}

fn authorize(
    operation: &GitOperation,
    context: &TaskContext,
    kind: OperationActionKind,
) -> Result<(), TaskFailure> {
    let identity = context
        .operation_identity()
        .ok_or_else(|| changed("An owner task is required for Pull."))?;
    if identity.operation_id != operation.operation_id
        || identity.version != operation.version
        || identity.repo_id != operation.repo_id
        || identity.resource_key != operation.resource_key
        || !kind.allowed(operation)
    {
        return Err(changed(
            "The Pull task does not match the operation boundary.",
        ));
    }
    Ok(())
}

fn pull_request(
    request: &OperationRequest,
) -> Result<(RemotePullStrategy, &str, &str, &str), TaskFailure> {
    match &request.command {
        OperationCommand::PullMerge {
            remote,
            branch,
            target_oid,
        } => Ok((RemotePullStrategy::Merge, remote, branch, target_oid)),
        OperationCommand::PullRebase {
            remote,
            branch,
            target_oid,
        } => Ok((RemotePullStrategy::Rebase, remote, branch, target_oid)),
        _ => Err(changed("An explicit Pull command is required.")),
    }
}

fn preparing() -> OperationState {
    OperationState {
        status: OperationStatus::Running,
        ..OperationState::default()
    }
}

fn check_cancel(context: &TaskContext) -> Result<(), TaskFailure> {
    if context.cancellation_requested() {
        Err(TaskFailure::Cancelled)
    } else {
        Ok(())
    }
}

fn changed(message: &str) -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, message)
}

fn unknown(message: &str) -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::OutcomeUnknown, message)
}
