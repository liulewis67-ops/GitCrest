use serde::{Deserialize, Serialize};

use crate::{api::workflow::WorkflowOperationDto, domain::workflow::WorkflowOperation};

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
    pub(super) operation_in_progress: Option<WorkflowOperationDto>,
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
            operation_in_progress: preflight.operation_in_progress.map(Into::into),
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
    #[serde(deserialize_with = "deserialize_workflow_operation")]
    pub(super) expected_operation: WorkflowOperation,
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
    #[serde(deserialize_with = "deserialize_workflow_operation")]
    pub(super) expected_operation: WorkflowOperation,
    pub(super) expected_head_oid: Option<String>,
    pub(super) expected_result_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowConflictMutationRequest {
    pub(super) task_id: String,
    pub(super) path: String,
    #[serde(deserialize_with = "deserialize_workflow_operation")]
    pub(super) expected_operation: WorkflowOperation,
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

fn deserialize_workflow_operation<'de, D>(deserializer: D) -> Result<WorkflowOperation, D::Error>
where
    D: serde::Deserializer<'de>,
{
    WorkflowOperationDto::deserialize(deserializer).map(WorkflowOperation::from)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkflowRecoveryPreflightDto {
    pub(super) repo_id: String,
    pub(super) task_id: String,
    pub(super) operation: WorkflowOperationDto,
    pub(super) head_oid: Option<String>,
    pub(super) dirty_paths: Vec<String>,
    pub(super) omitted_dirty_path_count: u32,
    pub(super) conflicted_paths: Vec<String>,
    pub(super) omitted_conflicted_path_count: u32,
    pub(super) can_continue: bool,
    pub(super) can_skip: bool,
    pub(super) can_abort: bool,
}

impl From<super::service::WorkflowRecoveryPreflight> for WorkflowRecoveryPreflightDto {
    fn from(preflight: super::service::WorkflowRecoveryPreflight) -> Self {
        Self {
            repo_id: preflight.repo_id,
            task_id: preflight.task_id,
            operation: preflight.operation.into(),
            head_oid: preflight.head_oid,
            dirty_paths: preflight.dirty_paths,
            omitted_dirty_path_count: preflight.omitted_dirty_path_count,
            conflicted_paths: preflight.conflicted_paths,
            omitted_conflicted_path_count: preflight.omitted_conflicted_path_count,
            can_continue: preflight.can_continue,
            can_skip: preflight.can_skip,
            can_abort: preflight.can_abort,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConflictFileDto {
    pub(super) repo_id: String,
    pub(super) task_id: String,
    pub(super) path: String,
    pub(super) operation: WorkflowOperationDto,
    pub(super) head_oid: Option<String>,
    pub(super) base_content: Option<String>,
    pub(super) ours_content: Option<String>,
    pub(super) theirs_content: Option<String>,
    pub(super) result_content: Option<String>,
    pub(super) result_revision: String,
    pub(super) is_text: bool,
}

impl From<super::conflicts::ConflictFile> for ConflictFileDto {
    fn from(file: super::conflicts::ConflictFile) -> Self {
        Self {
            repo_id: file.repo_id,
            task_id: file.task_id,
            path: file.path,
            operation: file.operation.into(),
            head_oid: file.head_oid,
            base_content: file.base_content,
            ours_content: file.ours_content,
            theirs_content: file.theirs_content,
            result_content: file.result_content,
            result_revision: file.result_revision,
            is_text: file.is_text,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RebasePreviewDto {
    pub(super) repo_id: String,
    pub(super) head_oid: Option<String>,
    pub(super) onto_oid: String,
    pub(super) current_branch: Option<String>,
    pub(super) commits: Vec<super::rebase::RebaseCommit>,
    pub(super) omitted_commit_count: u32,
    pub(super) published_commit_oids: Vec<String>,
    pub(super) dirty_paths: Vec<String>,
    pub(super) omitted_dirty_path_count: u32,
    pub(super) operation_in_progress: Option<WorkflowOperationDto>,
    pub(super) preview_revision: String,
    pub(super) can_start: bool,
}

impl From<super::rebase::RebasePreview> for RebasePreviewDto {
    fn from(preview: super::rebase::RebasePreview) -> Self {
        Self {
            repo_id: preview.repo_id,
            head_oid: preview.head_oid,
            onto_oid: preview.onto_oid,
            current_branch: preview.current_branch,
            commits: preview.commits,
            omitted_commit_count: preview.omitted_commit_count,
            published_commit_oids: preview.published_commit_oids,
            dirty_paths: preview.dirty_paths,
            omitted_dirty_path_count: preview.omitted_dirty_path_count,
            operation_in_progress: preview.operation_in_progress.map(Into::into),
            preview_revision: preview.preview_revision,
            can_start: preview.can_start,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RebaseBackupSnapshotDto {
    pub(super) head_oid: Option<String>,
    pub(super) current_branch: Option<String>,
    pub(super) dirty_paths: Vec<String>,
    pub(super) operation_in_progress: Option<WorkflowOperationDto>,
    pub(super) backups: Vec<super::rebase::RebaseBackup>,
    pub(super) can_rollback: bool,
}

impl From<super::rebase::RebaseBackupSnapshot> for RebaseBackupSnapshotDto {
    fn from(snapshot: super::rebase::RebaseBackupSnapshot) -> Self {
        Self {
            head_oid: snapshot.head_oid,
            current_branch: snapshot.current_branch,
            dirty_paths: snapshot.dirty_paths,
            operation_in_progress: snapshot.operation_in_progress.map(Into::into),
            backups: snapshot.backups,
            can_rollback: snapshot.can_rollback,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResetPreviewDto {
    pub(super) repo_id: String,
    pub(super) expected_head_oid: String,
    pub(super) target_oid: String,
    pub(super) current_branch: String,
    pub(super) mode: super::reset::ResetMode,
    pub(super) commits_removed: u32,
    pub(super) commits_added: u32,
    pub(super) affected_paths: Vec<String>,
    pub(super) omitted_path_count: u32,
    pub(super) dirty_paths: Vec<String>,
    pub(super) operation_in_progress: Option<WorkflowOperationDto>,
    pub(super) preview_revision: String,
    pub(super) can_start: bool,
}

impl From<super::reset::ResetPreview> for ResetPreviewDto {
    fn from(preview: super::reset::ResetPreview) -> Self {
        Self {
            repo_id: preview.repo_id,
            expected_head_oid: preview.expected_head_oid,
            target_oid: preview.target_oid,
            current_branch: preview.current_branch,
            mode: preview.mode,
            commits_removed: preview.commits_removed,
            commits_added: preview.commits_added,
            affected_paths: preview.affected_paths,
            omitted_path_count: preview.omitted_path_count,
            dirty_paths: preview.dirty_paths,
            operation_in_progress: preview.operation_in_progress.map(Into::into),
            preview_revision: preview.preview_revision,
            can_start: preview.can_start,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResetBackupSnapshotDto {
    pub(super) head_oid: Option<String>,
    pub(super) current_branch: Option<String>,
    pub(super) dirty_paths: Vec<String>,
    pub(super) operation_in_progress: Option<WorkflowOperationDto>,
    pub(super) backups: Vec<super::reset::ResetBackup>,
    pub(super) can_restore: bool,
}

impl From<super::reset::ResetBackupSnapshot> for ResetBackupSnapshotDto {
    fn from(snapshot: super::reset::ResetBackupSnapshot) -> Self {
        Self {
            head_oid: snapshot.head_oid,
            current_branch: snapshot.current_branch,
            dirty_paths: snapshot.dirty_paths,
            operation_in_progress: snapshot.operation_in_progress.map(Into::into),
            backups: snapshot.backups,
            can_restore: snapshot.can_restore,
        }
    }
}
