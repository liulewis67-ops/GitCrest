use super::*;
use crate::{
    domain::{diff::DiffScope, status::StatusFile},
    ports::{git::GitReadPort, status::StatusReadPort},
};
use std::collections::BTreeSet;

pub(crate) struct PullPreviewPorts<'a, G> {
    pub git: &'a G,
    pub branches: &'a dyn BranchGitPort,
    pub remote_read: &'a dyn RemotePreflightReadPort,
    pub remotes: &'a dyn RemoteGitPort,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PullPreservationReason {
    StagedChanges,
    OverwriteRisk,
    IncompletePaths,
    DirtyRebase,
    KeepOnSource,
}

#[derive(PartialEq, Eq)]
pub(crate) struct PullProtectionPreview {
    pub preflight: PullPreflight,
    pub overlapping_paths: Vec<String>,
    pub has_staged_changes: bool,
}
impl PullProtectionPreview {
    pub fn preservation_reason(
        &self,
        strategy: RemotePullStrategy,
    ) -> Option<PullPreservationReason> {
        if self.preflight.is_clean {
            return None;
        }
        if strategy == RemotePullStrategy::Rebase {
            Some(PullPreservationReason::DirtyRebase)
        } else if self.preflight.omitted_dirty_path_count > 0 {
            Some(PullPreservationReason::IncompletePaths)
        } else if self.has_staged_changes {
            Some(PullPreservationReason::StagedChanges)
        } else if !self.overlapping_paths.is_empty() {
            Some(PullPreservationReason::OverwriteRisk)
        } else {
            None
        }
    }
}

/// Reads the last fetched target only. Call again after fetching and under the
/// execution permit; this preview performs no network or repository writes.
pub(crate) async fn read_pull_protection<G: GitReadPort + StatusReadPort>(
    ports: PullPreviewPorts<'_, G>,
    repo: &str,
    path: &Path,
    current: Option<&str>,
    detached: bool,
) -> Result<PullProtectionPreview, PullError> {
    let before = read_pull_preflight(
        repo.into(),
        path,
        current,
        detached,
        ports.branches,
        ports.remote_read,
        ports.remotes,
    )
    .await?;
    let files = read_files(ports.git, repo, path).await?;
    let primary = files
        .iter()
        .map(|f| f.path.as_str())
        .collect::<BTreeSet<_>>();
    let listed = before
        .dirty_paths
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if !listed.is_subset(&primary)
        || primary.len() != listed.len() + before.omitted_dirty_path_count as usize
    {
        return Err(PullError::PreflightChanged);
    }
    let paths = primary
        .iter()
        .map(|p| (*p).to_owned())
        .chain(files.iter().filter_map(|f| f.original_path.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let has_staged_changes = files
        .iter()
        .any(|f| f.has_changes_for_scope(DiffScope::Index));
    let overlapping_paths =
        crate::features::branches::overlapping_dirty_paths_between_oids_with_git(
            path,
            &before.local_oid,
            &before.tracking_oid,
            &paths,
            ports.branches,
        )
        .await
        .map_err(|error| match error {
            crate::features::branches::BranchError::GitUnavailable => PullError::GitUnavailable,
            crate::features::branches::BranchError::TimedOut => PullError::TimedOut,
            crate::features::branches::BranchError::TooLarge => PullError::TooLarge,
            _ => PullError::GitFailed,
        })?;
    let after = read_pull_preflight(
        repo.into(),
        path,
        current,
        detached,
        ports.branches,
        ports.remote_read,
        ports.remotes,
    )
    .await?;
    if before != after
        || files != read_files(ports.git, repo, path).await?
        || ports
            .git
            .read_head_oid(path)
            .await
            .map_err(map_workflow_error)?
            .as_deref()
            != Some(before.local_oid.as_str())
        || ports
            .git
            .read_current_branch(path)
            .await
            .map_err(map_workflow_error)?
            .as_deref()
            != current
    {
        return Err(PullError::PreflightChanged);
    }
    let mut preflight = before;
    preflight.merge_requires_preservation = has_staged_changes
        || !overlapping_paths.is_empty()
        || preflight.omitted_dirty_path_count > 0;
    Ok(PullProtectionPreview {
        preflight,
        overlapping_paths,
        has_staged_changes,
    })
}

async fn read_files<G: StatusReadPort>(
    git: &G,
    repo: &str,
    path: &Path,
) -> Result<Vec<StatusFile>, PullError> {
    let mut files = git
        .read_status(repo.into(), path, &[])
        .await
        .map_err(|_| PullError::GitFailed)?
        .files;
    if files.len() > 1000 {
        return Err(PullError::TooLarge);
    }
    files.retain(StatusFile::has_unignored_changes);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}
