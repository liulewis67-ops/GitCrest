use super::query::OperationRecoveryView;
use crate::domain::{git_result::GitFailureCode, operation::*, operation_action::*};
use serde::Serialize;

/// Deliberate public projection: canonical resource paths, patches and Task logs
/// stay private. CAS versions and snapshot revisions are decimal strings to
/// preserve every i64 value.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OperationRecoveryResponse {
    revision: String,
    operation_id: String,
    repo_id: String,
    request_id: String,
    version: String,
    request: OperationRequest,
    state: OperationState,
    steps: Vec<OperationStep>,
    backups: Vec<OperationBackup>,
    preservation_plan: Option<OperationPreservationPlan>,
    actions: Vec<ActionDto>,
    owns_resource: bool,
    owns_repository: bool,
    actions_enabled: bool,
    allowed_actions: Vec<OperationActionKind>,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionDto {
    request_id: String,
    kind: OperationActionKind,
    expected_version: String,
    admitted_version: String,
    status: OperationActionStatus,
    task_id: Option<String>,
    preservation_start_sequence: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    planned_step: Option<OperationStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    merge_resolution_fingerprint: Option<String>,
    result_version: Option<String>,
    failure_code: Option<GitFailureCode>,
}

impl From<OperationRecoveryView> for OperationRecoveryResponse {
    fn from(view: OperationRecoveryView) -> Self {
        let snapshot = view.snapshot;
        let op = snapshot.operation;
        Self {
            revision: snapshot.revision.to_string(),
            operation_id: op.operation_id,
            repo_id: op.repo_id,
            request_id: op.request_id,
            version: op.version.to_string(),
            request: op.request,
            state: op.state,
            steps: op.steps,
            backups: op.backups,
            preservation_plan: op.preservation_plan,
            actions: snapshot
                .actions
                .into_iter()
                .map(|a| ActionDto {
                    request_id: a.request.request_id,
                    kind: a.request.kind,
                    expected_version: a.request.expected_version.to_string(),
                    admitted_version: a.admitted_version.to_string(),
                    status: a.status,
                    task_id: a.task_id,
                    preservation_start_sequence: a.preservation_start_sequence,
                    planned_step: a.planned_step,
                    merge_resolution_fingerprint: a.merge_resolution_fingerprint,
                    result_version: a.result_version.map(|v| v.to_string()),
                    failure_code: a.failure_code,
                })
                .collect(),
            owns_resource: snapshot.owns_resource,
            owns_repository: snapshot.owns_repository,
            // Read access does not enable the unfinished public write protocol.
            actions_enabled: false,
            allowed_actions: Vec::new(),
            created_at_ms: op.created_at_ms,
            updated_at_ms: op.updated_at_ms,
        }
    }
}
