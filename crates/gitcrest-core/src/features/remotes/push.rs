use std::path::Path;

use crate::{
    domain::error::GitAdapterError,
    domain::remote::RemotePushCommand,
    ports::{branches::BranchGitPort, remotes::RemoteGitPort},
};
use serde::Serialize;

const MAX_PREVIEW_PATHS: usize = 200;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPreflight {
    pub repo_id: String,
    pub local_branch: String,
    pub remote_name: String,
    pub remote_branch: String,
    pub local_oid: String,
    pub expected_remote_oid: String,
    pub ahead: u32,
    pub behind: u32,
    pub commits_to_push: Vec<PushCommit>,
    pub overwritten_commit_count: u32,
    pub changed_paths: Vec<String>,
    pub changed_path_count: u32,
    pub omitted_changed_path_count: u32,
}

impl From<&PushPreflight> for RemotePushCommand {
    fn from(preflight: &PushPreflight) -> Self {
        Self {
            repo_id: preflight.repo_id.clone(),
            local_branch: preflight.local_branch.clone(),
            remote_name: preflight.remote_name.clone(),
            remote_branch: preflight.remote_branch.clone(),
            local_oid: preflight.local_oid.clone(),
            expected_remote_oid: preflight.expected_remote_oid.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushCommit {
    pub oid: String,
    pub subject: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PushError {
    NoCurrentBranch,
    NoUpstream,
    InvalidUpstream,
    UpstreamGone,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
}

#[cfg(test)]
pub async fn read_push_preflight(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
) -> Result<PushPreflight, PushError> {
    read_push_preflight_for_target(
        repo_id,
        repository_path,
        current,
        detached,
        None,
        &crate::git::refs::GitBranchAdapter,
        &crate::git::remotes::GitRemoteAdapter,
    )
    .await
}

pub async fn read_push_preflight_for_target(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
    target: Option<(&str, &str)>,
    branch_git: &dyn BranchGitPort,
    remote_git: &dyn RemoteGitPort,
) -> Result<PushPreflight, PushError> {
    if detached || current.is_none() {
        return Err(PushError::NoCurrentBranch);
    }
    let local_branch = current.ok_or(PushError::NoCurrentBranch)?;
    if !crate::domain::branch::is_branch_name_syntactically_valid(local_branch)
        || !branch_git
            .validate_name(repository_path, local_branch)
            .await
            .map_err(|_| PushError::NoCurrentBranch)?
    {
        return Err(PushError::NoCurrentBranch);
    }
    let (local_oid, remote_name, remote_branch) = if let Some((remote_name, remote_branch)) = target
    {
        crate::features::remotes::validate_remote_name_with_git(
            repository_path,
            remote_name,
            remote_git,
        )
        .await
        .map_err(|_| PushError::InvalidUpstream)?;
        let remotes = crate::features::remotes::read_remotes_with_git(
            repo_id.clone(),
            repository_path,
            remote_git,
        )
        .await
        .map_err(|_| PushError::InvalidUpstream)?;
        if !remotes
            .remotes
            .iter()
            .any(|remote| remote.name == remote_name)
        {
            return Err(PushError::InvalidUpstream);
        }
        if !crate::domain::branch::is_branch_name_syntactically_valid(remote_branch)
            || !branch_git
                .validate_name(repository_path, remote_branch)
                .await
                .map_err(|_| PushError::InvalidUpstream)?
        {
            return Err(PushError::InvalidUpstream);
        }
        let local_oid = remote_git
            .resolve_local_commit(repository_path, local_branch)
            .await
            .map_err(map_remote_git_error)?;
        (local_oid, remote_name.to_owned(), remote_branch.to_owned())
    } else {
        let upstream = remote_git
            .read_branch_upstream(repository_path, local_branch)
            .await
            .map_err(map_remote_git_error)?;
        let local_oid = upstream.local_oid;
        let remote_name = upstream.remote_name;
        let remote_ref = upstream.remote_ref;
        if remote_name.is_empty() || remote_ref.is_empty() {
            return Err(PushError::NoUpstream);
        }
        if remote_name == "." || !remote_ref.starts_with("refs/heads/") {
            return Err(PushError::InvalidUpstream);
        }
        let remote_branch = remote_ref
            .strip_prefix("refs/heads/")
            .filter(|name| !name.is_empty())
            .ok_or(PushError::InvalidUpstream)?;
        (local_oid, remote_name, remote_branch.to_owned())
    };
    crate::features::remotes::validate_remote_name_with_git(
        repository_path,
        &remote_name,
        remote_git,
    )
    .await
    .map_err(|_| PushError::InvalidUpstream)?;
    if !crate::domain::branch::is_branch_name_syntactically_valid(&remote_branch)
        || !branch_git
            .validate_name(repository_path, &remote_branch)
            .await
            .map_err(|_| PushError::InvalidUpstream)?
    {
        return Err(PushError::InvalidUpstream);
    }
    let expected_remote_oid = remote_git
        .resolve_tracking_commit(repository_path, &remote_name, &remote_branch)
        .await
        .map_err(|error| match error {
            GitAdapterError::Failed => PushError::UpstreamGone,
            other => map_remote_git_error(other),
        })?
        .ok_or(PushError::UpstreamGone)?;
    let divergence = remote_git
        .compare_tracking_branch(repository_path, local_branch, &remote_name, &remote_branch)
        .await
        .map_err(map_remote_git_error)?;
    let commits_to_push = remote_git
        .list_commits_to_push(repository_path, local_branch, &remote_name, &remote_branch)
        .await
        .map_err(map_remote_git_error)?
        .into_iter()
        .map(|commit| PushCommit {
            oid: commit.oid,
            subject: commit.subject,
        })
        .collect::<Vec<_>>();
    let paths = remote_git
        .list_changed_paths_to_push(repository_path, local_branch, &remote_name, &remote_branch)
        .await
        .map_err(map_remote_git_error)?;
    let changed_path_count = u32::try_from(paths.len()).map_err(|_| PushError::TooLarge)?;
    let changed_paths = paths
        .iter()
        .take(MAX_PREVIEW_PATHS)
        .cloned()
        .collect::<Vec<_>>();
    Ok(PushPreflight {
        repo_id,
        local_branch: local_branch.to_owned(),
        remote_name: remote_name.to_owned(),
        remote_branch,
        local_oid,
        expected_remote_oid,
        ahead: divergence.ahead,
        behind: divergence.behind,
        commits_to_push,
        overwritten_commit_count: divergence.behind,
        changed_path_count,
        omitted_changed_path_count: changed_path_count.saturating_sub(changed_paths.len() as u32),
        changed_paths,
    })
}

fn map_remote_git_error(error: GitAdapterError) -> PushError {
    match error {
        GitAdapterError::Unavailable => PushError::GitUnavailable,
        GitAdapterError::TimedOut => PushError::TimedOut,
        GitAdapterError::OutputTooLarge => PushError::TooLarge,
        GitAdapterError::Failed | GitAdapterError::ReferenceAlreadyExists => PushError::GitFailed,
    }
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

    fn commit(path: &Path, file: &str, content: &str, subject: &str) {
        std::fs::write(path.join(file), content).unwrap();
        git(path, &["add", file]);
        git(path, &["commit", "--quiet", "-m", subject]);
    }

    #[tokio::test]
    async fn preflight_reports_push_and_overwrite_scope_for_diverged_upstream() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join("local");
        let other = directory.path().join("other");
        let bare = directory.path().join("origin.git");
        std::fs::create_dir(&local).unwrap();
        git(&local, &["init", "--quiet"]);
        git(&local, &["config", "user.name", "Push Test"]);
        git(&local, &["config", "user.email", "push@example.invalid"]);
        commit(&local, "base.txt", "base\n", "base");
        git(
            directory.path(),
            &["init", "--bare", "--quiet", bare.to_str().unwrap()],
        );
        git(&local, &["remote", "add", "origin", bare.to_str().unwrap()]);
        let branch = git(&local, &["branch", "--show-current"]);
        git(&local, &["push", "--quiet", "-u", "origin", &branch]);
        commit(&local, "local.txt", "local\n", "local change");
        git(
            directory.path(),
            &[
                "clone",
                "--quiet",
                bare.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        git(&other, &["config", "user.name", "Other Test"]);
        git(&other, &["config", "user.email", "other@example.invalid"]);
        commit(&other, "remote.txt", "remote\n", "remote change");
        git(&other, &["push", "--quiet", "origin", &branch]);
        git(&local, &["fetch", "--quiet", "origin"]);

        let preview = read_push_preflight("repo_fixture".into(), &local, Some(&branch), false)
            .await
            .unwrap();
        assert_eq!(preview.remote_name, "origin");
        assert_eq!(preview.remote_branch, branch);
        assert_eq!(preview.ahead, 1);
        assert_eq!(preview.behind, 1);
        assert_eq!(preview.overwritten_commit_count, 1);
        assert_eq!(preview.commits_to_push[0].subject, "local change");
        assert_eq!(preview.changed_path_count, 2);
        assert!(preview.changed_paths.contains(&"local.txt".into()));
        assert!(preview.changed_paths.contains(&"remote.txt".into()));
    }
}
