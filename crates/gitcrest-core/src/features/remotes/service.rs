use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    domain::{error::GitAdapterError, workflow::WorkflowOperation},
    ports::{
        branches::BranchGitPort,
        remotes::{RemoteGitPort, RemotePreflightReadPort},
    },
};

#[cfg(test)]
use crate::git::remotes::GitRemoteAdapter;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSnapshot {
    pub repo_id: String,
    pub default_remote: Option<String>,
    pub remotes: Vec<RemoteRef>,
}

#[derive(Clone, Debug)]
pub struct RemoteBranchDeletePreview {
    pub repo_id: String,
    pub remote_name: String,
    pub remote_branch: String,
    pub target_ref: String,
    pub expected_remote_oid: String,
    pub current_head_oid: Option<String>,
    pub commits_only_on_remote: u32,
    pub affected_paths: Vec<String>,
    pub omitted_path_count: u32,
    pub operation_in_progress: Option<WorkflowOperation>,
    pub preview_revision: String,
    pub can_delete: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRef {
    pub name: String,
    pub fetch_urls: Vec<String>,
    pub push_urls: Vec<String>,
    pub is_default: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RemoteError {
    InvalidName,
    InvalidUrl,
    BranchNotFound,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
}

pub async fn read_remote_branch_delete_preview<G: RemotePreflightReadPort + ?Sized>(
    git: &G,
    branch_git: &dyn BranchGitPort,
    remote_git: &dyn RemoteGitPort,
    repo_id: String,
    repository_path: &Path,
    remote_name: &str,
    remote_branch: &str,
) -> Result<RemoteBranchDeletePreview, RemoteError> {
    validate_remote_name_with_git(repository_path, remote_name, remote_git).await?;
    if !crate::domain::branch::is_branch_name_syntactically_valid(remote_branch)
        || !branch_git
            .validate_name(repository_path, remote_branch)
            .await
            .map_err(|_| RemoteError::InvalidName)?
    {
        return Err(RemoteError::InvalidName);
    }
    if !read_remotes_with_git(repo_id.clone(), repository_path, remote_git)
        .await?
        .remotes
        .iter()
        .any(|remote| remote.name == remote_name)
    {
        return Err(RemoteError::InvalidName);
    }
    let target_ref = format!("refs/remotes/{remote_name}/{remote_branch}");
    if remote_branch == "HEAD" {
        return Err(RemoteError::InvalidName);
    }
    let expected_remote_oid = git
        .resolve_target(repository_path, &target_ref)
        .await
        .map_err(|error| match error {
            crate::domain::error::WorkflowError::GitFailed => RemoteError::BranchNotFound,
            other => remote_workflow_error(other),
        })?;
    let current_head_oid = git
        .read_head(repository_path)
        .await
        .map_err(remote_workflow_error)?;
    let comparison = git
        .compare_delete_impact(
            repository_path,
            current_head_oid.as_deref(),
            &expected_remote_oid,
        )
        .await
        .map_err(remote_workflow_error)?;
    let commits_only_on_remote = comparison.commits_only_on_remote;
    let mut affected_paths = comparison.affected_paths;
    affected_paths.sort();
    affected_paths.dedup();
    let omitted_path_count = affected_paths.len().saturating_sub(200) as u32;
    affected_paths.truncate(200);
    let operation_in_progress = git
        .read_worktree(repository_path)
        .await
        .map_err(|_| RemoteError::GitFailed)?
        .operation;
    let can_delete = operation_in_progress.is_none();
    let mut digest = Sha256::new();
    digest.update(repo_id.as_bytes());
    digest.update([0]);
    digest.update(target_ref.as_bytes());
    digest.update([0]);
    digest.update(expected_remote_oid.as_bytes());
    digest.update([0]);
    digest.update(current_head_oid.as_deref().unwrap_or_default().as_bytes());
    digest.update([0]);
    digest.update(format!("{operation_in_progress:?}").as_bytes());
    digest.update([0]);
    for path in &affected_paths {
        digest.update(path.as_bytes());
        digest.update([0]);
    }
    Ok(RemoteBranchDeletePreview {
        repo_id,
        remote_name: remote_name.to_owned(),
        remote_branch: remote_branch.to_owned(),
        target_ref,
        expected_remote_oid,
        current_head_oid,
        commits_only_on_remote,
        affected_paths,
        omitted_path_count,
        operation_in_progress,
        preview_revision: format!("sha256:{:x}", digest.finalize()),
        can_delete,
    })
}

fn remote_workflow_error(error: crate::domain::error::WorkflowError) -> RemoteError {
    match error {
        crate::domain::error::WorkflowError::GitUnavailable => RemoteError::GitUnavailable,
        crate::domain::error::WorkflowError::TimedOut => RemoteError::TimedOut,
        crate::domain::error::WorkflowError::TooLarge => RemoteError::TooLarge,
        crate::domain::error::WorkflowError::InvalidTarget
        | crate::domain::error::WorkflowError::CommitNotFound
        | crate::domain::error::WorkflowError::NoActiveOperation
        | crate::domain::error::WorkflowError::GitFailed => RemoteError::GitFailed,
    }
}

pub async fn read_remotes_with_git(
    repo_id: String,
    repository_path: &Path,
    remote_git: &dyn RemoteGitPort,
) -> Result<RemoteSnapshot, RemoteError> {
    let configuration = remote_git
        .read_configuration(repository_path)
        .await
        .map_err(map_git_adapter_error)?;
    let mut remotes = configuration
        .remotes
        .into_iter()
        .map(|remote| RemoteRef {
            name: remote.name,
            fetch_urls: remote
                .fetch_urls
                .iter()
                .map(|url| safe_remote_url(url))
                .collect(),
            push_urls: remote
                .push_urls
                .iter()
                .map(|url| safe_remote_url(url))
                .collect(),
            is_default: false,
        })
        .collect::<Vec<_>>();
    let default_remote = configuration
        .configured_default
        .filter(|name| remotes.iter().any(|remote| remote.name == *name))
        .or_else(|| {
            remotes
                .iter()
                .any(|remote| remote.name == "origin")
                .then(|| "origin".to_owned())
        });
    for remote in &mut remotes {
        remote.is_default = default_remote.as_deref() == Some(remote.name.as_str());
    }
    Ok(RemoteSnapshot {
        repo_id,
        default_remote,
        remotes,
    })
}

pub async fn validate_remote_name_with_git(
    repository_path: &Path,
    name: &str,
    remote_git: &dyn RemoteGitPort,
) -> Result<(), RemoteError> {
    if !crate::domain::remote::is_remote_name_syntactically_valid(name) {
        return Err(RemoteError::InvalidName);
    }
    match remote_git
        .validate_name(repository_path, name)
        .await
        .map_err(map_git_adapter_error)?
    {
        true => Ok(()),
        false => Err(RemoteError::InvalidName),
    }
}

fn map_git_adapter_error(error: GitAdapterError) -> RemoteError {
    match error {
        GitAdapterError::Unavailable => RemoteError::GitUnavailable,
        GitAdapterError::TimedOut => RemoteError::TimedOut,
        GitAdapterError::OutputTooLarge => RemoteError::TooLarge,
        GitAdapterError::Failed | GitAdapterError::ReferenceAlreadyExists => RemoteError::GitFailed,
    }
}

#[cfg(test)]
pub async fn read_remotes(
    repo_id: String,
    repository_path: &Path,
) -> Result<RemoteSnapshot, RemoteError> {
    read_remotes_with_git(repo_id, repository_path, &GitRemoteAdapter).await
}

pub fn validate_remote_url(url: &str) -> Result<(), RemoteError> {
    crate::features::repositories::cloning::validate_remote_url(url)
        .map_err(|_| RemoteError::InvalidUrl)
}

pub fn safe_remote_url(url: &str) -> String {
    let without_query = url.split(['?', '#']).next().unwrap_or_default();
    let Some((scheme, remainder)) = without_query.split_once("://") else {
        return without_query.to_owned();
    };
    let authority_end = remainder.find('/').unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    let suffix = &remainder[authority_end..];
    if authority.contains('@') {
        let host = authority.rsplit('@').next().unwrap_or_default();
        format!("{scheme}://[REDACTED]@{host}{suffix}")
    } else {
        format!("{scheme}://{authority}{suffix}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, process::Command as StdCommand};

    fn git(path: &Path, args: &[&str]) {
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
    }

    #[test]
    fn strips_user_info_and_query_material_from_displayed_remote_urls() {
        assert_eq!(
            safe_remote_url("https://alice:secret@example.test/org/repo?token=hidden"),
            "https://[REDACTED]@example.test/org/repo"
        );
        assert_eq!(
            safe_remote_url("ssh://git@example.test/org/repo.git"),
            "ssh://[REDACTED]@example.test/org/repo.git"
        );
        assert_eq!(
            safe_remote_url("git@example.test:org/repo.git"),
            "git@example.test:org/repo.git"
        );
    }

    #[tokio::test]
    async fn reads_fetch_and_push_urls_and_uses_origin_as_default() {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--quiet"]);
        git(
            &repo,
            &[
                "remote",
                "add",
                "origin",
                "https://example.test/org/repo.git",
            ],
        );
        git(
            &repo,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                "ssh://git@example.test/org/repo.git",
            ],
        );
        let snapshot = read_remotes("repo_fixture".into(), &repo).await.unwrap();
        assert_eq!(snapshot.default_remote.as_deref(), Some("origin"));
        assert_eq!(snapshot.remotes.len(), 1);
        assert_eq!(
            snapshot.remotes[0].fetch_urls,
            ["https://example.test/org/repo.git"]
        );
        assert_eq!(
            snapshot.remotes[0].push_urls,
            ["ssh://[REDACTED]@example.test/org/repo.git"]
        );
        assert!(snapshot.remotes[0].is_default);

        git(
            &repo,
            &[
                "remote",
                "add",
                "upstream",
                "https://example.test/upstream.git",
            ],
        );
        git(
            &repo,
            &["config", "--local", "gitcrest.defaultRemote", "upstream"],
        );
        let snapshot = read_remotes("repo_fixture".into(), &repo).await.unwrap();
        assert_eq!(snapshot.default_remote.as_deref(), Some("upstream"));
        assert!(
            snapshot
                .remotes
                .iter()
                .find(|remote| remote.name == "upstream")
                .unwrap()
                .is_default
        );
        assert!(
            !snapshot
                .remotes
                .iter()
                .find(|remote| remote.name == "origin")
                .unwrap()
                .is_default
        );
    }
}
