use std::path::Path;

use crate::{
    domain::error::{GitAdapterError, WorkflowError},
    domain::remote::{RemotePullCommand, RemotePullStrategy},
    ports::{
        branches::BranchGitPort,
        remotes::{RemoteGitPort, RemotePreflightReadPort},
    },
};
use serde::{Deserialize, Serialize};
mod protection;
pub(crate) use protection::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullPreflight {
    pub repo_id: String,
    pub local_branch: String,
    pub remote_name: String,
    pub remote_branch: String,
    pub local_oid: String,
    pub tracking_oid: String,
    pub ahead: u32,
    pub behind: u32,
    pub is_clean: bool,
    pub merge_requires_preservation: bool,
    pub dirty_paths: Vec<String>,
    pub omitted_dirty_path_count: u32,
    pub has_conflicts: bool,
    pub operation_in_progress: bool,
}

impl From<&PullPreflight> for RemotePullCommand {
    fn from(preflight: &PullPreflight) -> Self {
        Self {
            local_branch: preflight.local_branch.clone(),
            remote_name: preflight.remote_name.clone(),
            remote_branch: preflight.remote_branch.clone(),
            local_oid: preflight.local_oid.clone(),
            tracking_oid: preflight.tracking_oid.clone(),
        }
    }
}

impl PullPreflight {
    pub(crate) fn can_pull(&self, strategy: RemotePullStrategy) -> bool {
        !self.has_conflicts
            && !self.operation_in_progress
            && match strategy {
                RemotePullStrategy::Merge => !self.merge_requires_preservation,
                RemotePullStrategy::Rebase => self.is_clean,
            }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PullStrategy {
    Merge,
    Rebase,
}

impl From<PullStrategy> for RemotePullStrategy {
    fn from(strategy: PullStrategy) -> Self {
        match strategy {
            PullStrategy::Merge => Self::Merge,
            PullStrategy::Rebase => Self::Rebase,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PullError {
    PreflightChanged,
    NoCurrentBranch,
    NoUpstream,
    InvalidUpstream,
    UpstreamGone,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
}

pub async fn read_pull_preflight<G: RemotePreflightReadPort + ?Sized>(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
    branch_git: &dyn BranchGitPort,
    git_read: &G,
    remote_git: &dyn RemoteGitPort,
) -> Result<PullPreflight, PullError> {
    if detached || current.is_none() {
        return Err(PullError::NoCurrentBranch);
    }
    let local_branch = current.ok_or(PullError::NoCurrentBranch)?;
    if !crate::domain::branch::is_branch_name_syntactically_valid(local_branch)
        || !branch_git
            .validate_name(repository_path, local_branch)
            .await
            .map_err(|_| PullError::NoCurrentBranch)?
    {
        return Err(PullError::NoCurrentBranch);
    }
    let upstream = remote_git
        .read_branch_upstream(repository_path, local_branch)
        .await
        .map_err(map_remote_git_error)?;
    let local_oid = upstream.local_oid;
    let remote_name = upstream.remote_name;
    let remote_ref = upstream.remote_ref;
    if remote_name.is_empty() || remote_ref.is_empty() {
        return Err(PullError::NoUpstream);
    }
    if remote_name == "." || !remote_ref.starts_with("refs/heads/") {
        return Err(PullError::InvalidUpstream);
    }
    crate::features::remotes::validate_remote_name_with_git(
        repository_path,
        &remote_name,
        remote_git,
    )
    .await
    .map_err(|_| PullError::InvalidUpstream)?;
    let remote_branch = remote_ref
        .strip_prefix("refs/heads/")
        .filter(|name| !name.is_empty())
        .ok_or(PullError::InvalidUpstream)?;
    if !crate::domain::branch::is_branch_name_syntactically_valid(remote_branch)
        || !branch_git
            .validate_name(repository_path, remote_branch)
            .await
            .map_err(|_| PullError::InvalidUpstream)?
    {
        return Err(PullError::InvalidUpstream);
    }
    let tracking_oid = remote_git
        .resolve_tracking_commit(repository_path, &remote_name, remote_branch)
        .await
        .map_err(|error| match error {
            GitAdapterError::Failed => PullError::UpstreamGone,
            other => map_remote_git_error(other),
        })?
        .ok_or(PullError::UpstreamGone)?;
    let divergence = remote_git
        .compare_tracking_branch(repository_path, local_branch, &remote_name, remote_branch)
        .await
        .map_err(map_remote_git_error)?;
    let worktree = git_read
        .read_worktree(repository_path)
        .await
        .map_err(map_workflow_error)?;
    let dirty_paths = worktree.dirty_paths;
    let omitted_dirty_path_count = worktree.omitted_dirty_path_count;
    let has_conflicts =
        !worktree.conflicted_paths.is_empty() || worktree.omitted_conflicted_path_count > 0;
    let operation_in_progress = worktree.operation.is_some();
    Ok(PullPreflight {
        repo_id,
        local_branch: local_branch.to_owned(),
        remote_name,
        remote_branch: remote_branch.to_owned(),
        local_oid,
        tracking_oid,
        ahead: divergence.ahead,
        behind: divergence.behind,
        is_clean: dirty_paths.is_empty() && !has_conflicts && !operation_in_progress,
        // The API enriches this with current staged changes and path overlap.
        merge_requires_preservation: !dirty_paths.is_empty(),
        dirty_paths,
        omitted_dirty_path_count,
        has_conflicts,
        operation_in_progress,
    })
}

fn map_remote_git_error(error: GitAdapterError) -> PullError {
    match error {
        GitAdapterError::Unavailable => PullError::GitUnavailable,
        GitAdapterError::TimedOut => PullError::TimedOut,
        GitAdapterError::OutputTooLarge => PullError::TooLarge,
        GitAdapterError::Failed | GitAdapterError::ReferenceAlreadyExists => PullError::GitFailed,
    }
}

fn map_workflow_error(error: WorkflowError) -> PullError {
    match error {
        WorkflowError::GitUnavailable => PullError::GitUnavailable,
        WorkflowError::TimedOut => PullError::TimedOut,
        WorkflowError::TooLarge => PullError::TooLarge,
        WorkflowError::InvalidTarget
        | WorkflowError::CommitNotFound
        | WorkflowError::NoActiveOperation
        | WorkflowError::GitFailed => PullError::GitFailed,
    }
}

#[cfg(test)]
mod tests {
    use crate::ports::git::GitReadPort;

    #[test]
    fn parses_dirty_paths_and_conflicts_from_porcelain_v2() {
        let output = b"1 .M N... 100644 100644 100644 1111111 1111111 changed.txt\0? untracked.txt\0u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflicted.txt\0";
        let (paths, omitted, conflicts, omitted_conflicts) =
            crate::git::status::parse_status(output).unwrap();
        assert_eq!(paths, ["changed.txt", "untracked.txt", "conflicted.txt"]);
        assert_eq!(omitted, 0);
        assert_eq!(conflicts, ["conflicted.txt"]);
        assert_eq!(omitted_conflicts, 0);
    }

    #[tokio::test]
    async fn detects_an_operation_marker_in_the_repository_git_directory() {
        let directory = tempfile::tempdir().unwrap();
        let output = std::process::Command::new("git")
            .arg("init")
            .arg("--quiet")
            .arg(directory.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        let marker = directory.path().join(".git").join("rebase-merge");
        std::fs::create_dir(&marker).unwrap();

        let state = crate::git::command::GitCommandService::default()
            .read_worktree_state(directory.path())
            .await
            .unwrap();
        assert_eq!(
            state.operation,
            Some(crate::domain::workflow::WorkflowOperation::Rebase)
        );
    }
}
