use crate::{
    domain::{operation::PreservationPolicy, status::StatusFile},
    features::{
        branches,
        shelves::planning::{self, PlanningError, PreservationPlan},
    },
    ports::{
        branches::BranchGitPort,
        diff::{DiffGitPort, DiffWorktreePort},
        git::GitReadPort,
        status::StatusReadPort,
    },
};
use std::{collections::BTreeSet, path::Path};

#[cfg(test)]
pub(crate) mod tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CheckoutTargetRequest {
    LocalBranch(String),
    Commit(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ResolvedCheckoutTarget {
    LocalBranch { name: String, oid: String },
    DetachedCommit { oid: String },
}
impl ResolvedCheckoutTarget {
    pub fn operation_command(&self) -> crate::domain::operation::OperationCommand {
        use crate::domain::operation::OperationCommand;
        match self {
            Self::LocalBranch { name, oid } => OperationCommand::CheckoutBranch {
                name: name.clone(),
                target_oid: oid.clone(),
            },
            Self::DetachedCommit { oid } => OperationCommand::CheckoutDetached {
                target_oid: oid.clone(),
            },
        }
    }
    pub fn oid(&self) -> &str {
        match self {
            Self::LocalBranch { oid, .. } | Self::DetachedCommit { oid } => oid,
        }
    }
}

pub(crate) struct CheckoutPreviewInput<'a> {
    pub target: &'a CheckoutTargetRequest,
    pub preservation: PreservationPolicy,
    pub shelf_name: &'a str,
    pub shelf_description: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PreservationReason {
    SafeToCarry,
    OverwriteRisk,
    KeepOnSource,
}

pub(crate) struct CheckoutPreview {
    pub target: ResolvedCheckoutTarget,
    pub source_head: String,
    pub source_branch: Option<String>,
    pub reason: PreservationReason,
    pub overlapping_paths: Vec<String>,
    pub preservation: Option<PreservationPlan>,
}

#[derive(Debug)]
pub(crate) enum PreviewError {
    Pull(crate::features::remotes::pull::PullError),
    Unavailable,
    InvalidTarget,
    TargetNotFound,
    TargetInUse,
    AlreadyCurrent,
    MissingSource,
    ActiveWorkflow,
    TooLarge,
    Changed,
    Preservation(PlanningError),
}

#[derive(PartialEq, Eq)]
struct Source {
    head: String,
    branch: Option<String>,
    files: Vec<StatusFile>,
    paths: Vec<String>,
}

/// Read-only local checkout preview. Direct carry-over does not require patch
/// support. This is not an execution lease or a public preview revision token.
pub(crate) async fn read_checkout<G: GitReadPort + DiffGitPort + StatusReadPort>(
    git: &G,
    worktree: &dyn DiffWorktreePort,
    branch_git: &dyn BranchGitPort,
    repo_id: &str,
    path: &Path,
    input: CheckoutPreviewInput<'_>,
) -> Result<CheckoutPreview, PreviewError> {
    let source = read_source(git, repo_id, path).await?;
    let target = resolve(git, branch_git, path, input.target, &source).await?;
    let overlapping_paths = branches::overlapping_dirty_paths_between_oids_with_git(
        path,
        &source.head,
        target.oid(),
        &source.paths,
        branch_git,
    )
    .await
    .map_err(|_| PreviewError::Unavailable)?;
    let reason = if source.paths.is_empty() {
        PreservationReason::SafeToCarry
    } else if input.preservation == PreservationPolicy::KeepOnSourceBranch {
        PreservationReason::KeepOnSource
    } else if !overlapping_paths.is_empty() {
        PreservationReason::OverwriteRisk
    } else {
        PreservationReason::SafeToCarry
    };
    let preservation = if reason != PreservationReason::SafeToCarry {
        let plan = planning::read_plan(
            git,
            worktree,
            repo_id,
            path,
            input.shelf_name,
            input.shelf_description,
        )
        .await
        .map_err(PreviewError::Preservation)?;
        if !plan
            .before
            .matches_source(Some(&source.head), source.branch.as_deref())
        {
            return Err(PreviewError::Changed);
        }
        Some(plan)
    } else {
        None
    };
    if read_source(git, repo_id, path).await? != source
        || resolve(git, branch_git, path, input.target, &source).await? != target
    {
        return Err(PreviewError::Changed);
    }
    Ok(CheckoutPreview {
        target,
        source_head: source.head,
        source_branch: source.branch,
        reason,
        overlapping_paths,
        preservation,
    })
}

async fn read_source<G: GitReadPort + StatusReadPort>(
    git: &G,
    repo: &str,
    path: &Path,
) -> Result<Source, PreviewError> {
    let head = git
        .read_head_oid(path)
        .await
        .map_err(|_| PreviewError::Unavailable)?
        .ok_or(PreviewError::MissingSource)?;
    let branch = git
        .read_current_branch(path)
        .await
        .map_err(|_| PreviewError::Unavailable)?;
    let state = git
        .read_worktree_state(path)
        .await
        .map_err(|_| PreviewError::Unavailable)?;
    if state.operation.is_some()
        || !state.conflicted_paths.is_empty()
        || state.omitted_conflicted_path_count > 0
    {
        return Err(PreviewError::ActiveWorkflow);
    }
    if state.omitted_dirty_path_count > 0 {
        return Err(PreviewError::TooLarge);
    }
    let mut files = git
        .read_status(repo.into(), path, &[])
        .await
        .map_err(|_| PreviewError::Unavailable)?
        .files;
    if files.len() > 1000 {
        return Err(PreviewError::TooLarge);
    }
    files.retain(StatusFile::has_unignored_changes);
    if files.iter().any(StatusFile::is_conflicted) {
        return Err(PreviewError::ActiveWorkflow);
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let paths = files
        .iter()
        .map(|f| f.path.clone())
        .collect::<BTreeSet<_>>();
    if paths != state.dirty_paths.into_iter().collect() {
        return Err(PreviewError::Changed);
    }
    // Both ends of a rename/copy can overlap a target even if status reports
    // only the destination as its primary dirty path.
    let paths = paths
        .into_iter()
        .chain(files.iter().filter_map(|f| f.original_path.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(Source {
        head,
        branch,
        files,
        paths,
    })
}

async fn resolve<G: GitReadPort>(
    git: &G,
    branches: &dyn BranchGitPort,
    path: &Path,
    request: &CheckoutTargetRequest,
    source: &Source,
) -> Result<ResolvedCheckoutTarget, PreviewError> {
    match request {
        CheckoutTargetRequest::LocalBranch(name) => {
            branches::validate_branch_name_with_git(path, name, branches)
                .await
                .map_err(|_| PreviewError::InvalidTarget)?;
            if source.branch.as_deref() == Some(name) {
                return Err(PreviewError::AlreadyCurrent);
            }
            let references = branches
                .list_references(path)
                .await
                .map_err(|_| PreviewError::Unavailable)?;
            let full_ref = format!("refs/heads/{name}");
            let reference = references
                .iter()
                .find(|r| r.full_name == full_ref)
                .ok_or(PreviewError::TargetNotFound)?;
            if reference.worktree_path.is_some() {
                return Err(PreviewError::TargetInUse);
            }
            // Resolve the fully qualified ref, never an ambiguous branch/tag label.
            let oid = git
                .resolve_commit_target(path, &full_ref)
                .await
                .map_err(|_| PreviewError::TargetNotFound)?;
            if oid != reference.oid {
                return Err(PreviewError::Changed);
            }
            Ok(ResolvedCheckoutTarget::LocalBranch {
                name: name.clone(),
                oid,
            })
        }
        CheckoutTargetRequest::Commit(value) => {
            if !(4..=64).contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(PreviewError::InvalidTarget);
            }
            let oid = git
                .resolve_commit_target(path, value)
                .await
                .map_err(|_| PreviewError::TargetNotFound)?;
            if oid == source.head {
                return Err(PreviewError::AlreadyCurrent);
            }
            Ok(ResolvedCheckoutTarget::DetachedCommit { oid })
        }
    }
}
