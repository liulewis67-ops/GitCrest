use super::preview::PreviewError;
use crate::{
    domain::{
        operation::PreservationPolicy,
        remote::{RemotePullCommand, RemotePullStrategy},
    },
    features::{
        remotes::pull::{self, PullPreflight, PullPreservationReason, PullPreviewPorts},
        shelves::planning::{self, PreservationPlan},
    },
    ports::{
        branches::BranchGitPort,
        diff::{DiffGitPort, DiffWorktreePort},
        git::GitReadPort,
        remotes::{RemoteGitPort, RemotePreflightReadPort},
        status::StatusReadPort,
    },
};
use std::path::Path;

#[cfg(test)]
mod tests;

pub(crate) struct PullPreviewInput<'a> {
    pub strategy: RemotePullStrategy,
    pub preservation: PreservationPolicy,
    pub shelf_name: &'a str,
    pub shelf_description: &'a str,
}
pub(crate) struct PullPreview {
    pub preflight: PullPreflight,
    pub command: RemotePullCommand,
    pub strategy: RemotePullStrategy,
    pub reason: Option<PullPreservationReason>,
    pub preservation: Option<PreservationPlan>,
}

/// Does not fetch. Execution must review the actual fetched target again before
/// saving or running merge/rebase; remote-tracking refs are not a remote lease.
pub(crate) async fn read_pull<
    G: GitReadPort + RemotePreflightReadPort + DiffGitPort + StatusReadPort,
>(
    git: &G,
    worktree: &dyn DiffWorktreePort,
    branches: &dyn BranchGitPort,
    remotes: &dyn RemoteGitPort,
    repo: &str,
    path: &Path,
    input: PullPreviewInput<'_>,
) -> Result<PullPreview, PreviewError> {
    let current = git
        .read_current_branch(path)
        .await
        .map_err(|_| PreviewError::Unavailable)?;
    let ports = || PullPreviewPorts {
        git,
        branches,
        remote_read: git,
        remotes,
    };
    let before =
        pull::read_pull_protection(ports(), repo, path, current.as_deref(), current.is_none())
            .await
            .map_err(PreviewError::Pull)?;
    if before.preflight.has_conflicts || before.preflight.operation_in_progress {
        return Err(PreviewError::ActiveWorkflow);
    }
    let reason = if !before.preflight.is_clean
        && input.preservation == PreservationPolicy::KeepOnSourceBranch
    {
        Some(PullPreservationReason::KeepOnSource)
    } else {
        before.preservation_reason(input.strategy)
    };
    let preservation = if reason.is_some() {
        let plan = planning::read_plan(
            git,
            worktree,
            repo,
            path,
            input.shelf_name,
            input.shelf_description,
        )
        .await
        .map_err(PreviewError::Preservation)?;
        if !plan.before.matches_source(
            Some(&before.preflight.local_oid),
            Some(&before.preflight.local_branch),
        ) {
            return Err(PreviewError::Changed);
        }
        Some(plan)
    } else {
        None
    };
    let after =
        pull::read_pull_protection(ports(), repo, path, current.as_deref(), current.is_none())
            .await
            .map_err(PreviewError::Pull)?;
    if before != after {
        return Err(PreviewError::Changed);
    }
    Ok(PullPreview {
        command: RemotePullCommand::from(&before.preflight),
        preflight: before.preflight,
        strategy: input.strategy,
        reason,
        preservation,
    })
}
