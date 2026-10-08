use serde::Deserialize;

use super::service::WorkflowAction;
use crate::{rebase, reset};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowPreflightQuery {
    pub(super) action: WorkflowAction,
    pub(super) target_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowRequest {
    pub(super) action: WorkflowAction,
    pub(super) target_oid: String,
    pub(super) expected_head_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowRecoveryQuery {
    pub(super) task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowRecoveryRequest {
    pub(super) task_id: String,
    pub(super) action: super::service::WorkflowRecoveryAction,
    pub(super) expected_operation: super::service::WorkflowOperation,
    pub(super) expected_head_oid: String,
    pub(super) expected_conflicted_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RebasePreviewQuery {
    pub(super) onto_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RebaseRequest {
    pub(super) expected_head_oid: String,
    pub(super) expected_onto_oid: String,
    pub(super) preview_revision: String,
    pub(super) todo: Vec<rebase::RebaseTodoItem>,
    pub(super) confirm_drop: bool,
    pub(super) confirm_published_rewrite: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RebaseRollbackRequest {
    pub(super) expected_head_oid: String,
    pub(super) backup_reference: String,
    pub(super) backup_oid: String,
    pub(super) confirm_rollback: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ResetPreviewQuery {
    pub(super) target_oid: String,
    pub(super) mode: reset::ResetMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ResetRequest {
    pub(super) expected_head_oid: String,
    pub(super) target_oid: String,
    pub(super) mode: reset::ResetMode,
    pub(super) preview_revision: String,
    pub(super) confirm_reset: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ResetRestoreRequest {
    pub(super) expected_head_oid: String,
    pub(super) backup_reference: String,
    pub(super) backup_oid: String,
    pub(super) confirm_restore: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowConflictFileQuery {
    pub(super) task_id: String,
    pub(super) path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowConflictSuggestionRequest {
    pub(super) task_id: String,
    pub(super) path: String,
    pub(super) expected_operation: super::service::WorkflowOperation,
    pub(super) expected_head_oid: Option<String>,
    pub(super) expected_result_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowConflictMutationRequest {
    pub(super) task_id: String,
    pub(super) path: String,
    pub(super) expected_operation: super::service::WorkflowOperation,
    pub(super) expected_head_oid: String,
    pub(super) expected_result_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowConflictSaveRequest {
    #[serde(flatten)]
    pub(super) mutation: WorkflowConflictMutationRequest,
    pub(super) content: String,
}
