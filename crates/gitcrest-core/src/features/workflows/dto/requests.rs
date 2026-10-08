use serde::Deserialize;

use crate::{
    api::workflow::{WorkflowActionDto, WorkflowOperationDto},
    domain::workflow::WorkflowOperation,
};

use super::super::reset;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct WorkflowPreflightQuery {
    pub(in crate::workflows) action: WorkflowActionDto,
    pub(in crate::workflows) target_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct WorkflowRequest {
    pub(in crate::workflows) action: WorkflowActionDto,
    pub(in crate::workflows) target_oid: String,
    pub(in crate::workflows) expected_head_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct WorkflowRecoveryQuery {
    pub(in crate::workflows) task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct WorkflowRecoveryRequest {
    pub(in crate::workflows) task_id: String,
    pub(in crate::workflows) action: WorkflowRecoveryActionDto,
    #[serde(deserialize_with = "deserialize_workflow_operation")]
    pub(in crate::workflows) expected_operation: WorkflowOperation,
    pub(in crate::workflows) expected_head_oid: String,
    pub(in crate::workflows) expected_conflicted_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::workflows) enum WorkflowRecoveryActionDto {
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
pub(in crate::workflows) struct RebasePreviewQuery {
    pub(in crate::workflows) onto_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct RebaseRequest {
    pub(in crate::workflows) expected_head_oid: String,
    pub(in crate::workflows) expected_onto_oid: String,
    pub(in crate::workflows) preview_revision: String,
    pub(in crate::workflows) todo: Vec<RebaseTodoItemDto>,
    pub(in crate::workflows) confirm_drop: bool,
    pub(in crate::workflows) confirm_published_rewrite: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct RebaseTodoItemDto {
    pub(in crate::workflows) oid: String,
    pub(in crate::workflows) action: RebaseActionDto,
    pub(in crate::workflows) message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(in crate::workflows) enum RebaseActionDto {
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
pub(in crate::workflows) struct RebaseRollbackRequest {
    pub(in crate::workflows) expected_head_oid: String,
    pub(in crate::workflows) backup_reference: String,
    pub(in crate::workflows) backup_oid: String,
    pub(in crate::workflows) confirm_rollback: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct ResetPreviewQuery {
    pub(in crate::workflows) target_oid: String,
    pub(in crate::workflows) mode: reset::ResetMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct ResetRequest {
    pub(in crate::workflows) expected_head_oid: String,
    pub(in crate::workflows) target_oid: String,
    pub(in crate::workflows) mode: reset::ResetMode,
    pub(in crate::workflows) preview_revision: String,
    pub(in crate::workflows) confirm_reset: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct ResetRestoreRequest {
    pub(in crate::workflows) expected_head_oid: String,
    pub(in crate::workflows) backup_reference: String,
    pub(in crate::workflows) backup_oid: String,
    pub(in crate::workflows) confirm_restore: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct WorkflowConflictFileQuery {
    pub(in crate::workflows) task_id: String,
    pub(in crate::workflows) path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct WorkflowConflictSuggestionRequest {
    pub(in crate::workflows) task_id: String,
    pub(in crate::workflows) path: String,
    #[serde(deserialize_with = "deserialize_workflow_operation")]
    pub(in crate::workflows) expected_operation: WorkflowOperation,
    pub(in crate::workflows) expected_head_oid: Option<String>,
    pub(in crate::workflows) expected_result_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct WorkflowConflictMutationRequest {
    pub(in crate::workflows) task_id: String,
    pub(in crate::workflows) path: String,
    #[serde(deserialize_with = "deserialize_workflow_operation")]
    pub(in crate::workflows) expected_operation: WorkflowOperation,
    pub(in crate::workflows) expected_head_oid: String,
    pub(in crate::workflows) expected_result_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::workflows) struct WorkflowConflictSaveRequest {
    #[serde(flatten)]
    pub(in crate::workflows) mutation: WorkflowConflictMutationRequest,
    pub(in crate::workflows) content: String,
}

fn deserialize_workflow_operation<'de, D>(deserializer: D) -> Result<WorkflowOperation, D::Error>
where
    D: serde::Deserializer<'de>,
{
    WorkflowOperationDto::deserialize(deserializer).map(WorkflowOperation::from)
}
