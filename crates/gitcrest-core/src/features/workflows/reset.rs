use std::path::Path;

use crate::{
    domain::{
        error::WorkflowError,
        workflow::{WorkflowBackupNamespace, WorkflowOperation},
    },
    ports::git::GitReadPort,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_RESET_PATHS: usize = 200;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

impl ResetMode {
    pub fn git_argument(self) -> &'static str {
        match self {
            Self::Soft => "--soft",
            Self::Mixed => "--mixed",
            Self::Hard => "--hard",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ResetPreview {
    pub repo_id: String,
    pub expected_head_oid: String,
    pub target_oid: String,
    pub current_branch: String,
    pub mode: ResetMode,
    pub commits_removed: u32,
    pub commits_added: u32,
    pub affected_paths: Vec<String>,
    pub omitted_path_count: u32,
    pub dirty_paths: Vec<String>,
    pub operation_in_progress: Option<WorkflowOperation>,
    pub preview_revision: String,
    pub can_start: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetBackup {
    pub reference: String,
    pub oid: String,
    pub subject: String,
}

#[derive(Clone, Debug)]
pub struct ResetBackupSnapshot {
    pub head_oid: Option<String>,
    pub current_branch: Option<String>,
    pub dirty_paths: Vec<String>,
    pub operation_in_progress: Option<WorkflowOperation>,
    pub backups: Vec<ResetBackup>,
    pub can_restore: bool,
}

pub async fn read_backup_snapshot<G: GitReadPort>(
    git: &G,
    repository_path: &Path,
) -> Result<ResetBackupSnapshot, WorkflowError> {
    let head_oid = git.read_head_oid(repository_path).await?;
    let current_branch = git.read_current_branch(repository_path).await?;
    let state = git.read_worktree_state(repository_path).await?;
    let operation_in_progress = state.operation;
    let mut backups = git
        .list_backup_references(repository_path, WorkflowBackupNamespace::Reset)
        .await?
        .into_iter()
        .map(|backup| ResetBackup {
            reference: backup.reference,
            oid: backup.oid,
            subject: backup.subject,
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.reference.cmp(&left.reference));
    let can_restore = head_oid.is_some()
        && current_branch.is_some()
        && state.dirty_paths.is_empty()
        && operation_in_progress.is_none()
        && !backups.is_empty();
    Ok(ResetBackupSnapshot {
        head_oid,
        current_branch,
        dirty_paths: state.dirty_paths,
        operation_in_progress,
        backups,
        can_restore,
    })
}

pub async fn read_preview<G: GitReadPort>(
    git: &G,
    repo_id: String,
    repository_path: &Path,
    target: &str,
    mode: ResetMode,
) -> Result<ResetPreview, WorkflowError> {
    if !(4..=64).contains(&target.len()) || !target.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorkflowError::InvalidTarget);
    }
    let target_oid = git.resolve_commit_target(repository_path, target).await?;
    let expected_head_oid = git
        .read_head_oid(repository_path)
        .await?
        .ok_or(WorkflowError::GitFailed)?;
    let current_branch = git
        .read_current_branch(repository_path)
        .await?
        .ok_or(WorkflowError::GitFailed)?;
    let comparison = git
        .compare_for_reset(repository_path, &expected_head_oid, &target_oid)
        .await?;
    let state = git.read_worktree_state(repository_path).await?;
    let operation_in_progress = state.operation;
    let mut affected_paths = comparison.changed_paths;
    affected_paths.sort();
    affected_paths.dedup();
    let omitted_path_count = affected_paths.len().saturating_sub(MAX_RESET_PATHS) as u32;
    affected_paths.truncate(MAX_RESET_PATHS);
    let can_start = expected_head_oid != target_oid
        && operation_in_progress.is_none()
        && (mode != ResetMode::Hard || state.dirty_paths.is_empty());
    let mut digest = Sha256::new();
    digest.update(repo_id.as_bytes());
    digest.update([0]);
    digest.update(expected_head_oid.as_bytes());
    digest.update([0]);
    digest.update(target_oid.as_bytes());
    digest.update([0]);
    digest.update(current_branch.as_bytes());
    digest.update([0]);
    digest.update(mode.git_argument().as_bytes());
    digest.update([0]);
    digest.update(format!("{operation_in_progress:?}").as_bytes());
    digest.update([0]);
    for path in &affected_paths {
        digest.update(path.as_bytes());
        digest.update([0]);
    }
    for path in &state.dirty_paths {
        digest.update(path.as_bytes());
        digest.update([0]);
    }
    Ok(ResetPreview {
        repo_id,
        expected_head_oid,
        target_oid,
        current_branch,
        mode,
        commits_removed: comparison.commits_removed,
        commits_added: comparison.commits_added,
        affected_paths,
        omitted_path_count,
        dirty_paths: state.dirty_paths,
        operation_in_progress,
        preview_revision: format!("sha256:{:x}", digest.finalize()),
        can_start,
    })
}
