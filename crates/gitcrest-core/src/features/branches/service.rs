use std::path::Path;

use serde::Serialize;

use crate::{
    domain::{
        branch::{is_branch_name_syntactically_valid, BranchReference},
        error::GitAdapterError,
    },
    ports::branches::BranchGitPort,
};

#[cfg(test)]
use crate::git::refs::GitBranchAdapter;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSnapshot {
    pub repo_id: String,
    pub current: Option<String>,
    pub detached: bool,
    pub branches: Vec<BranchRef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRef {
    pub name: String,
    pub full_name: String,
    pub oid: String,
    pub kind: BranchKind,
    pub is_current: bool,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub is_favorite: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BranchKind {
    Local,
    Remote,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BranchError {
    InvalidName,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
}

pub async fn validate_branch_name_with_git(
    repository_path: &Path,
    name: &str,
    git: &dyn BranchGitPort,
) -> Result<(), BranchError> {
    if !is_branch_name_syntactically_valid(name) {
        return Err(BranchError::InvalidName);
    }
    match git
        .validate_name(repository_path, name)
        .await
        .map_err(map_git_error)?
    {
        true => Ok(()),
        false => Err(BranchError::InvalidName),
    }
}

pub async fn unmerged_commit_count_with_git(
    repository_path: &Path,
    current: &str,
    branch: &str,
    git: &dyn BranchGitPort,
) -> Result<u32, BranchError> {
    git.unmerged_commit_count(repository_path, current, branch)
        .await
        .map_err(map_git_error)
}

pub async fn paths_changed_between_with_git(
    repository_path: &Path,
    current: &str,
    target: &str,
    git: &dyn BranchGitPort,
) -> Result<Vec<String>, BranchError> {
    git.paths_changed_between(repository_path, current, target)
        .await
        .map_err(map_git_error)
}

pub async fn read_branches_with_git(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
    git: &dyn BranchGitPort,
) -> Result<BranchSnapshot, BranchError> {
    let references = git
        .list_references(repository_path)
        .await
        .map_err(map_git_error)?;
    let branches = references
        .into_iter()
        .map(|branch| map_branch_reference(branch, current))
        .collect();
    Ok(BranchSnapshot {
        repo_id,
        current: current.map(str::to_owned),
        detached,
        branches,
    })
}

fn map_branch_reference(branch: BranchReference, current: Option<&str>) -> BranchRef {
    let kind = if branch.full_name.starts_with("refs/heads/") {
        BranchKind::Local
    } else {
        BranchKind::Remote
    };
    let is_current = matches!(kind, BranchKind::Local) && current == Some(branch.name.as_str());
    BranchRef {
        name: branch.name,
        full_name: branch.full_name,
        oid: branch.oid,
        kind,
        is_current,
        upstream: branch.upstream,
        upstream_gone: branch.upstream_gone,
        ahead: branch.ahead,
        behind: branch.behind,
        is_favorite: false,
    }
}

fn map_git_error(error: GitAdapterError) -> BranchError {
    match error {
        GitAdapterError::Unavailable => BranchError::GitUnavailable,
        GitAdapterError::TimedOut => BranchError::TimedOut,
        GitAdapterError::OutputTooLarge => BranchError::TooLarge,
        GitAdapterError::Failed | GitAdapterError::ReferenceAlreadyExists => BranchError::GitFailed,
    }
}

#[cfg(test)]
pub async fn read_branches(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
) -> Result<BranchSnapshot, BranchError> {
    read_branches_with_git(
        repo_id,
        repository_path,
        current,
        detached,
        &GitBranchAdapter,
    )
    .await
}

#[cfg(test)]
fn parse_track(value: &str) -> Result<(Option<u32>, Option<u32>, bool), BranchError> {
    crate::git::refs::parse_branch_track(value).map_err(map_git_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, process::Command as StdCommand};

    fn git(path: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    #[tokio::test]
    async fn reads_local_remote_upstream_and_ahead_behind_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("repo");
        std::fs::create_dir(&path).unwrap();
        git(&path, &["init", "--quiet"]);
        git(&path, &["config", "user.name", "Branch Test"]);
        git(&path, &["config", "user.email", "branch@example.invalid"]);
        std::fs::write(path.join("file.txt"), "base\n").unwrap();
        git(&path, &["add", "file.txt"]);
        git(&path, &["commit", "--quiet", "-m", "base"]);
        let default = git(&path, &["branch", "--show-current"]);
        let bare = directory.path().join("origin.git");
        git(
            directory.path(),
            &["init", "--bare", "--quiet", bare.to_str().unwrap()],
        );
        git(&path, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&path, &["push", "--quiet", "-u", "origin", &default]);
        git(&path, &["checkout", "--quiet", "-b", "feature/one"]);
        git(&path, &["push", "--quiet", "-u", "origin", "feature/one"]);
        std::fs::write(path.join("file.txt"), "ahead\n").unwrap();
        git(&path, &["commit", "--quiet", "-am", "ahead"]);

        let snapshot = read_branches("repo_fixture".into(), &path, Some("feature/one"), false)
            .await
            .unwrap();
        assert_eq!(snapshot.current.as_deref(), Some("feature/one"));
        let current = snapshot
            .branches
            .iter()
            .find(|branch| branch.is_current)
            .unwrap();
        assert_eq!(current.upstream.as_deref(), Some("origin/feature/one"));
        assert_eq!(current.ahead, Some(1));
        assert_eq!(current.behind, Some(0));
        assert!(snapshot
            .branches
            .iter()
            .any(|branch| matches!(branch.kind, BranchKind::Remote)));
        assert!(snapshot
            .branches
            .iter()
            .any(|branch| branch.name == default && !branch.is_current));
    }

    #[test]
    fn parses_tracking_state_without_assuming_upstream_counts_exist() {
        assert_eq!(
            parse_track("[ahead 2, behind 3]"),
            Ok((Some(2), Some(3), false))
        );
        assert_eq!(parse_track("[ahead 1]"), Ok((Some(1), Some(0), false)));
        assert_eq!(parse_track("[behind 4]"), Ok((Some(0), Some(4), false)));
        assert_eq!(parse_track("[gone]"), Ok((None, None, true)));
        assert_eq!(parse_track(""), Ok((None, None, false)));
    }
}
