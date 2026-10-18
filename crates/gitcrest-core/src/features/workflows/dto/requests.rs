use serde::Deserialize;

use crate::{
    api::workflow::{WorkflowActionDto, WorkflowOperationDto},
    domain::workflow::WorkflowOperation,
};

use super::super::reset;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct WorkflowPreflightQuery {
    pub(in crate::features::workflows) action: WorkflowActionDto,
    pub(in crate::features::workflows) target_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct WorkflowRequest {
    pub(in crate::features::workflows) action: WorkflowActionDto,
    pub(in crate::features::workflows) target_oid: String,
    pub(in crate::features::workflows) expected_head_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct WorkflowRecoveryQuery {
    pub(in crate::features::workflows) task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct WorkflowRecoveryRequest {
    pub(in crate::features::workflows) task_id: String,
    pub(in crate::features::workflows) action: WorkflowRecoveryActionDto,
    #[serde(deserialize_with = "deserialize_workflow_operation")]
    pub(in crate::features::workflows) expected_operation: WorkflowOperation,
    pub(in crate::features::workflows) expected_head_oid: String,
    pub(in crate::features::workflows) expected_conflicted_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::features::workflows) enum WorkflowRecoveryActionDto {
    Continue,
    Skip,
    Abort,
}

impl From<WorkflowRecoveryActionDto> for crate::domain::workflow::WorkflowRecoveryAction {
    fn from(action: WorkflowRecoveryActionDto) -> Self {
        use crate::domain::workflow::WorkflowRecoveryAction;

        match action {
            WorkflowRecoveryActionDto::Continue => WorkflowRecoveryAction::Continue,
            WorkflowRecoveryActionDto::Skip => WorkflowRecoveryAction::Skip,
            WorkflowRecoveryActionDto::Abort => WorkflowRecoveryAction::Abort,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct RebasePreviewQuery {
    pub(in crate::features::workflows) onto_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct RebaseRequest {
    pub(in crate::features::workflows) expected_head_oid: String,
    pub(in crate::features::workflows) expected_onto_oid: String,
    pub(in crate::features::workflows) preview_revision: String,
    pub(in crate::features::workflows) todo: Vec<RebaseTodoItemDto>,
    pub(in crate::features::workflows) confirm_drop: bool,
    pub(in crate::features::workflows) confirm_published_rewrite: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct RebaseTodoItemDto {
    pub(in crate::features::workflows) oid: String,
    pub(in crate::features::workflows) action: RebaseActionDto,
    pub(in crate::features::workflows) message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(in crate::features::workflows) enum RebaseActionDto {
    Pick,
    Reword,
    Edit,
    Squash,
    Fixup,
    Drop,
}

impl From<RebaseTodoItemDto> for crate::domain::workflow::RebaseTodoItem {
    fn from(item: RebaseTodoItemDto) -> Self {
        use crate::domain::workflow::RebaseAction;

        let action = match item.action {
            RebaseActionDto::Pick => RebaseAction::Pick,
            RebaseActionDto::Reword => RebaseAction::Reword,
            RebaseActionDto::Edit => RebaseAction::Edit,
            RebaseActionDto::Squash => RebaseAction::Squash,
            RebaseActionDto::Fixup => RebaseAction::Fixup,
            RebaseActionDto::Drop => RebaseAction::Drop,
        };
        Self {
            oid: item.oid,
            action,
            message: item.message,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct RebaseRollbackRequest {
    pub(in crate::features::workflows) expected_head_oid: String,
    pub(in crate::features::workflows) backup_reference: String,
    pub(in crate::features::workflows) backup_oid: String,
    pub(in crate::features::workflows) confirm_rollback: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct ResetPreviewQuery {
    pub(in crate::features::workflows) target_oid: String,
    pub(in crate::features::workflows) mode: reset::ResetMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct ResetRequest {
    pub(in crate::features::workflows) expected_head_oid: String,
    pub(in crate::features::workflows) target_oid: String,
    pub(in crate::features::workflows) mode: reset::ResetMode,
    pub(in crate::features::workflows) preview_revision: String,
    pub(in crate::features::workflows) confirm_reset: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct ResetRestoreRequest {
    pub(in crate::features::workflows) expected_head_oid: String,
    pub(in crate::features::workflows) backup_reference: String,
    pub(in crate::features::workflows) backup_oid: String,
    pub(in crate::features::workflows) confirm_restore: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct WorkflowConflictFileQuery {
    pub(in crate::features::workflows) task_id: String,
    pub(in crate::features::workflows) path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct WorkflowConflictSuggestionRequest {
    pub(in crate::features::workflows) task_id: String,
    pub(in crate::features::workflows) path: String,
    #[serde(deserialize_with = "deserialize_workflow_operation")]
    pub(in crate::features::workflows) expected_operation: WorkflowOperation,
    pub(in crate::features::workflows) expected_head_oid: Option<String>,
    pub(in crate::features::workflows) expected_result_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct WorkflowConflictMutationRequest {
    pub(in crate::features::workflows) task_id: String,
    pub(in crate::features::workflows) path: String,
    #[serde(deserialize_with = "deserialize_workflow_operation")]
    pub(in crate::features::workflows) expected_operation: WorkflowOperation,
    pub(in crate::features::workflows) expected_head_oid: String,
    pub(in crate::features::workflows) expected_result_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct WorkflowConflictSaveRequest {
    #[serde(flatten)]
    pub(in crate::features::workflows) mutation: WorkflowConflictMutationRequest,
    pub(in crate::features::workflows) content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::features::workflows) struct WorkflowConflictChooseRequest {
    #[serde(flatten)]
    pub(in crate::features::workflows) mutation: WorkflowConflictMutationRequest,
    pub(in crate::features::workflows) side: WorkflowConflictSideDto,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(in crate::features::workflows) enum WorkflowConflictSideDto {
    Ours,
    Theirs,
}

fn deserialize_workflow_operation<'de, D>(deserializer: D) -> Result<WorkflowOperation, D::Error>
where
    D: serde::Deserializer<'de>,
{
    WorkflowOperationDto::deserialize(deserializer).map(WorkflowOperation::from)
}
