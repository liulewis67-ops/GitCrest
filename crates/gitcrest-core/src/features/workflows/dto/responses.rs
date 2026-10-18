use serde::Serialize;

use crate::api::workflow::{WorkflowActionDto, WorkflowOperationDto};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::features::workflows) struct WorkflowPreflightDto {
    pub(in crate::features::workflows) repo_id: String,
    pub(in crate::features::workflows) action: WorkflowActionDto,
    pub(in crate::features::workflows) head_oid: Option<String>,
    pub(in crate::features::workflows) target_oid: String,
    pub(in crate::features::workflows) target_subject: String,
    pub(in crate::features::workflows) operation_in_progress: Option<WorkflowOperationDto>,
    pub(in crate::features::workflows) is_clean: bool,
    pub(in crate::features::workflows) dirty_paths: Vec<String>,
    pub(in crate::features::workflows) omitted_dirty_path_count: u32,
    pub(in crate::features::workflows) conflicted_paths: Vec<String>,
    pub(in crate::features::workflows) omitted_conflicted_path_count: u32,
    pub(in crate::features::workflows) can_start: bool,
    pub(in crate::features::workflows) merge_kind: Option<&'static str>,
    pub(in crate::features::workflows) incoming_commit_count: Option<u32>,
}

impl From<super::super::service::WorkflowPreflight> for WorkflowPreflightDto {
    fn from(preflight: super::super::service::WorkflowPreflight) -> Self {
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
            merge_kind: preflight
                .merge_relation
                .map(|relation| match relation.kind {
                    crate::domain::workflow::MergeKind::UpToDate => "upToDate",
                    crate::domain::workflow::MergeKind::FastForward => "fastForward",
                    crate::domain::workflow::MergeKind::MergeCommit => "mergeCommit",
                }),
            incoming_commit_count: preflight
                .merge_relation
                .map(|relation| relation.incoming_commit_count),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::features::workflows) struct WorkflowRecoveryPreflightDto {
    pub(in crate::features::workflows) repo_id: String,
    pub(in crate::features::workflows) task_id: String,
    pub(in crate::features::workflows) operation: WorkflowOperationDto,
    pub(in crate::features::workflows) head_oid: Option<String>,
    pub(in crate::features::workflows) dirty_paths: Vec<String>,
    pub(in crate::features::workflows) omitted_dirty_path_count: u32,
    pub(in crate::features::workflows) conflicted_paths: Vec<String>,
    pub(in crate::features::workflows) omitted_conflicted_path_count: u32,
    pub(in crate::features::workflows) can_continue: bool,
    pub(in crate::features::workflows) can_skip: bool,
    pub(in crate::features::workflows) can_abort: bool,
}

impl From<super::super::service::WorkflowRecoveryPreflight> for WorkflowRecoveryPreflightDto {
    fn from(preflight: super::super::service::WorkflowRecoveryPreflight) -> Self {
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
pub(in crate::features::workflows) struct ConflictFileDto {
    pub(in crate::features::workflows) repo_id: String,
    pub(in crate::features::workflows) task_id: String,
    pub(in crate::features::workflows) path: String,
    pub(in crate::features::workflows) operation: WorkflowOperationDto,
    pub(in crate::features::workflows) head_oid: Option<String>,
    pub(in crate::features::workflows) base_content: Option<String>,
    pub(in crate::features::workflows) ours_content: Option<String>,
    pub(in crate::features::workflows) theirs_content: Option<String>,
    pub(in crate::features::workflows) result_content: Option<String>,
    pub(in crate::features::workflows) result_revision: String,
    pub(in crate::features::workflows) is_text: bool,
    pub(in crate::features::workflows) ours_present: bool,
    pub(in crate::features::workflows) theirs_present: bool,
}

impl From<super::super::conflicts::ConflictFile> for ConflictFileDto {
    fn from(file: super::super::conflicts::ConflictFile) -> Self {
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
            ours_present: file.ours_present,
            theirs_present: file.theirs_present,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::features::workflows) struct RebasePreviewDto {
    pub(in crate::features::workflows) repo_id: String,
    pub(in crate::features::workflows) head_oid: Option<String>,
    pub(in crate::features::workflows) onto_oid: String,
    pub(in crate::features::workflows) current_branch: Option<String>,
    pub(in crate::features::workflows) commits: Vec<super::super::rebase::RebaseCommit>,
    pub(in crate::features::workflows) omitted_commit_count: u32,
    pub(in crate::features::workflows) published_commit_oids: Vec<String>,
    pub(in crate::features::workflows) dirty_paths: Vec<String>,
    pub(in crate::features::workflows) omitted_dirty_path_count: u32,
    pub(in crate::features::workflows) operation_in_progress: Option<WorkflowOperationDto>,
    pub(in crate::features::workflows) preview_revision: String,
    pub(in crate::features::workflows) can_start: bool,
}

impl From<super::super::rebase::RebasePreview> for RebasePreviewDto {
    fn from(preview: super::super::rebase::RebasePreview) -> Self {
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
pub(in crate::features::workflows) struct RebaseBackupSnapshotDto {
    pub(in crate::features::workflows) head_oid: Option<String>,
    pub(in crate::features::workflows) current_branch: Option<String>,
    pub(in crate::features::workflows) dirty_paths: Vec<String>,
    pub(in crate::features::workflows) operation_in_progress: Option<WorkflowOperationDto>,
    pub(in crate::features::workflows) backups: Vec<super::super::rebase::RebaseBackup>,
    pub(in crate::features::workflows) can_rollback: bool,
}

impl From<super::super::rebase::RebaseBackupSnapshot> for RebaseBackupSnapshotDto {
    fn from(snapshot: super::super::rebase::RebaseBackupSnapshot) -> Self {
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
pub(in crate::features::workflows) struct ResetPreviewDto {
    pub(in crate::features::workflows) repo_id: String,
    pub(in crate::features::workflows) expected_head_oid: String,
    pub(in crate::features::workflows) target_oid: String,
    pub(in crate::features::workflows) current_branch: String,
    pub(in crate::features::workflows) mode: super::super::reset::ResetMode,
    pub(in crate::features::workflows) commits_removed: u32,
    pub(in crate::features::workflows) commits_added: u32,
    pub(in crate::features::workflows) affected_paths: Vec<String>,
    pub(in crate::features::workflows) omitted_path_count: u32,
    pub(in crate::features::workflows) dirty_paths: Vec<String>,
    pub(in crate::features::workflows) operation_in_progress: Option<WorkflowOperationDto>,
    pub(in crate::features::workflows) preview_revision: String,
    pub(in crate::features::workflows) can_start: bool,
}

impl From<super::super::reset::ResetPreview> for ResetPreviewDto {
    fn from(preview: super::super::reset::ResetPreview) -> Self {
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
pub(in crate::features::workflows) struct ResetBackupSnapshotDto {
    pub(in crate::features::workflows) head_oid: Option<String>,
    pub(in crate::features::workflows) current_branch: Option<String>,
    pub(in crate::features::workflows) dirty_paths: Vec<String>,
    pub(in crate::features::workflows) operation_in_progress: Option<WorkflowOperationDto>,
    pub(in crate::features::workflows) backups: Vec<super::super::reset::ResetBackup>,
    pub(in crate::features::workflows) can_restore: bool,
}

impl From<super::super::reset::ResetBackupSnapshot> for ResetBackupSnapshotDto {
    fn from(snapshot: super::super::reset::ResetBackupSnapshot) -> Self {
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
