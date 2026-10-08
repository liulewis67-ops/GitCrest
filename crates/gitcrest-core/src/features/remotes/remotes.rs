use std::{path::Path, process::Stdio, time::Duration};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const MAX_REMOTE_OUTPUT: usize = 8 * 1024 * 1024;
const REMOTE_READ_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSnapshot {
    pub repo_id: String,
    pub default_remote: Option<String>,
    pub remotes: Vec<RemoteRef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
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
    pub operation_in_progress: Option<crate::workflows::WorkflowOperation>,
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

pub async fn read_remote_branch_delete_preview(
    repo_id: String,
    repository_path: &Path,
    remote_name: &str,
    remote_branch: &str,
) -> Result<RemoteBranchDeletePreview, RemoteError> {
    validate_remote_name(repository_path, remote_name).await?;
    crate::branches::validate_branch_name(repository_path, remote_branch)
        .await
        .map_err(|_| RemoteError::InvalidName)?;
    if !read_remotes(repo_id.clone(), repository_path)
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
    let expected_remote_oid = match run_git(
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "--end-of-options".into(),
            format!("{target_ref}^{{commit}}").into(),
        ],
    )
    .await
    {
        Ok(value) => String::from_utf8_lossy(&value).trim().to_owned(),
        Err(RemoteError::GitFailed) => return Err(RemoteError::BranchNotFound),
        Err(error) => return Err(error),
    };
    let current_head_oid = match run_git(
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "HEAD^{commit}".into(),
        ],
    )
    .await
    {
        Ok(value) => Some(String::from_utf8_lossy(&value).trim().to_owned()),
        Err(RemoteError::GitFailed) => None,
        Err(error) => return Err(error),
    };
    let mut commits_only_on_remote = 0;
    let mut affected_paths = Vec::new();
    if let Some(head_oid) = &current_head_oid {
        let count = run_git(
            repository_path,
            &[
                "rev-list".into(),
                "--count".into(),
                format!("{head_oid}..{expected_remote_oid}").into(),
            ],
        )
        .await?;
        commits_only_on_remote = String::from_utf8_lossy(&count)
            .trim()
            .parse()
            .map_err(|_| RemoteError::GitFailed)?;
        let paths = run_git(
            repository_path,
            &[
                "diff".into(),
                "--name-only".into(),
                "--no-renames".into(),
                "-z".into(),
                head_oid.clone().into(),
                expected_remote_oid.clone().into(),
            ],
        )
        .await?;
        affected_paths = paths
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect();
    }
    affected_paths.sort();
    affected_paths.dedup();
    let omitted_path_count = affected_paths.len().saturating_sub(200) as u32;
    affected_paths.truncate(200);
    let (_, _, _, _, operation_in_progress) =
        crate::workflows::read_worktree_state(repository_path)
            .await
            .map_err(|_| RemoteError::GitFailed)?;
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

pub async fn read_remotes(
    repo_id: String,
    repository_path: &Path,
) -> Result<RemoteSnapshot, RemoteError> {
    let output = run_git(repository_path, &["remote".into(), "-v".into()]).await?;
    let text = std::str::from_utf8(&output).map_err(|_| RemoteError::GitFailed)?;
    let mut remotes = Vec::<RemoteRef>::new();
    for line in text.lines() {
        let Some((name, value)) = line.split_once('\t') else {
            return Err(RemoteError::GitFailed);
        };
        let (url, direction) = value.rsplit_once(" (").ok_or(RemoteError::GitFailed)?;
        let direction = direction.strip_suffix(')').ok_or(RemoteError::GitFailed)?;
        let url = safe_remote_url(url);
        let index = match remotes.iter().position(|remote| remote.name == name) {
            Some(index) => index,
            None if remotes.len() < 128 => {
                remotes.push(RemoteRef {
                    name: name.to_owned(),
                    fetch_urls: Vec::new(),
                    push_urls: Vec::new(),
                    is_default: false,
                });
                remotes.len() - 1
            }
            None => return Err(RemoteError::TooLarge),
        };
        match direction {
            "fetch" => remotes[index].fetch_urls.push(url),
            "push" => remotes[index].push_urls.push(url),
            _ => return Err(RemoteError::GitFailed),
        }
    }
    let configured = configured_default_remote(repository_path).await?;
    let default_remote = configured
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

pub async fn validate_remote_name(repository_path: &Path, name: &str) -> Result<(), RemoteError> {
    if name.is_empty()
        || name.len() > 255
        || name.chars().any(char::is_control)
        || name.starts_with('-')
    {
        return Err(RemoteError::InvalidName);
    }
    let reference = format!("refs/remotes/{name}/HEAD");
    match run_git(
        repository_path,
        &["check-ref-format".into(), reference.into()],
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(RemoteError::GitFailed) => Err(RemoteError::InvalidName),
        Err(error) => Err(error),
    }
}

pub fn validate_remote_url(url: &str) -> Result<(), RemoteError> {
    crate::cloning::validate_remote_url(url).map_err(|_| RemoteError::InvalidUrl)
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

async fn configured_default_remote(repository_path: &Path) -> Result<Option<String>, RemoteError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args(["config", "--local", "--get", "gitcrest.defaultRemote"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| RemoteError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(RemoteError::GitFailed)?;
    let reader = tokio::spawn(read_limited(stdout, 1024));
    let status = match tokio::time::timeout(REMOTE_READ_DEADLINE, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            let _ = child.kill().await;
            return Err(RemoteError::GitFailed);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(RemoteError::TimedOut);
        }
    };
    let output = reader
        .await
        .map_err(|_| RemoteError::GitFailed)?
        .map_err(|_| RemoteError::GitFailed)?;
    if output.len() > 1024 {
        return Err(RemoteError::TooLarge);
    }
    if status.success() {
        let value = String::from_utf8_lossy(&output).trim().to_owned();
        Ok((!value.is_empty()).then_some(value))
    } else if status.code() == Some(1) {
        Ok(None)
    } else {
        Err(RemoteError::GitFailed)
    }
}

async fn run_git(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<Vec<u8>, RemoteError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| RemoteError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(RemoteError::GitFailed)?;
    let reader = tokio::spawn(read_limited(stdout, MAX_REMOTE_OUTPUT));
    let status = match tokio::time::timeout(REMOTE_READ_DEADLINE, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            let _ = child.kill().await;
            return Err(RemoteError::GitFailed);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(RemoteError::TimedOut);
        }
    };
    let output = reader
        .await
        .map_err(|_| RemoteError::GitFailed)?
        .map_err(|_| RemoteError::GitFailed)?;
    if output.len() > MAX_REMOTE_OUTPUT {
        return Err(RemoteError::TooLarge);
    }
    if !status.success() {
        return Err(RemoteError::GitFailed);
    }
    Ok(output)
}

async fn read_limited<R>(reader: R, maximum: usize) -> Result<Vec<u8>, std::io::Error>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    reader
        .take(maximum.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
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
