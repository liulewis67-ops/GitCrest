use serde::{Deserialize, Serialize};

use super::reset;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowPreflightQuery {
    pub(super) action: WorkflowActionDto,
    pub(super) target_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowRequest {
    pub(super) action: WorkflowActionDto,
    pub(super) target_oid: String,
    pub(super) expected_head_oid: String,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum WorkflowActionDto {
    Merge,
    CherryPick,
    Revert,
}

impl From<WorkflowActionDto> for crate::domain::workflow::WorkflowAction {
    fn from(action: WorkflowActionDto) -> Self {
        use crate::domain::workflow::WorkflowAction;

        match action {
            WorkflowActionDto::Merge => WorkflowAction::Merge,
            WorkflowActionDto::CherryPick => WorkflowAction::CherryPick,
            WorkflowActionDto::Revert => WorkflowAction::Revert,
        }
    }
}

impl From<crate::domain::workflow::WorkflowAction> for WorkflowActionDto {
    fn from(action: crate::domain::workflow::WorkflowAction) -> Self {
        use crate::domain::workflow::WorkflowAction;

        match action {
            WorkflowAction::Merge => Self::Merge,
            WorkflowAction::CherryPick => Self::CherryPick,
            WorkflowAction::Revert => Self::Revert,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkflowPreflightDto {
    pub(super) repo_id: String,
    pub(super) action: WorkflowActionDto,
    pub(super) head_oid: Option<String>,
    pub(super) target_oid: String,
    pub(super) target_subject: String,
    pub(super) operation_in_progress: Option<super::service::WorkflowOperation>,
    pub(super) is_clean: bool,
    pub(super) dirty_paths: Vec<String>,
    pub(super) omitted_dirty_path_count: u32,
    pub(super) conflicted_paths: Vec<String>,
    pub(super) omitted_conflicted_path_count: u32,
    pub(super) can_start: bool,
}

impl From<super::service::WorkflowPreflight> for WorkflowPreflightDto {
    fn from(preflight: super::service::WorkflowPreflight) -> Self {
        Self {
            repo_id: preflight.repo_id,
            action: preflight.action.into(),
            head_oid: preflight.head_oid,
            target_oid: preflight.target_oid,
            target_subject: preflight.target_subject,
            operation_in_progress: preflight.operation_in_progress,
            is_clean: preflight.is_clean,
            dirty_paths: preflight.dirty_paths,
            omitted_dirty_path_count: preflight.omitted_dirty_path_count,
            conflicted_paths: preflight.conflicted_paths,
            omitted_conflicted_path_count: preflight.omitted_conflicted_path_count,
            can_start: preflight.can_start,
        }
    }
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
    pub(super) action: WorkflowRecoveryActionDto,
    pub(super) expected_operation: super::service::WorkflowOperation,
    pub(super) expected_head_oid: String,
    pub(super) expected_conflicted_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum WorkflowRecoveryActionDto {
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
pub(super) struct RebasePreviewQuery {
    pub(super) onto_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RebaseRequest {
    pub(super) expected_head_oid: String,
    pub(super) expected_onto_oid: String,
    pub(super) preview_revision: String,
    pub(super) todo: Vec<RebaseTodoItemDto>,
    pub(super) confirm_drop: bool,
    pub(super) confirm_published_rewrite: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RebaseTodoItemDto {
    pub(super) oid: String,
    pub(super) action: RebaseActionDto,
    pub(super) message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum RebaseActionDto {
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
