use std::{path::Path, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const MAX_PULL_PREFLIGHT_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_DIRTY_PATHS: usize = 200;
const PULL_PREFLIGHT_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize)]
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
    pub dirty_paths: Vec<String>,
    pub omitted_dirty_path_count: u32,
    pub has_conflicts: bool,
    pub operation_in_progress: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PullStrategy {
    Merge,
    Rebase,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PullError {
    NoCurrentBranch,
    NoUpstream,
    InvalidUpstream,
    UpstreamGone,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
}

pub async fn read_pull_preflight(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
) -> Result<PullPreflight, PullError> {
    if detached || current.is_none() {
        return Err(PullError::NoCurrentBranch);
    }
    let local_branch = current.ok_or(PullError::NoCurrentBranch)?;
    crate::features::branches::validate_branch_name(repository_path, local_branch)
        .await
        .map_err(|_| PullError::NoCurrentBranch)?;
    let config = run_git(
        repository_path,
        &[
            "for-each-ref".into(),
            "--format=%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)".into(),
            format!("refs/heads/{local_branch}").into(),
        ],
    )
    .await?;
    let fields = config.split(|byte| *byte == 0).collect::<Vec<_>>();
    if fields.len() < 3 {
        return Err(PullError::GitFailed);
    }
    let local_oid = text(fields[0])?.to_owned();
    let remote_name = text(fields[1])?.to_owned();
    let remote_ref = text(fields[2])?.to_owned();
    if remote_name.is_empty() || remote_ref.is_empty() {
        return Err(PullError::NoUpstream);
    }
    if remote_name == "." || !remote_ref.starts_with("refs/heads/") {
        return Err(PullError::InvalidUpstream);
    }
    crate::remotes::validate_remote_name(repository_path, &remote_name)
        .await
        .map_err(|_| PullError::InvalidUpstream)?;
    let remote_branch = remote_ref
        .strip_prefix("refs/heads/")
        .filter(|name| !name.is_empty())
        .ok_or(PullError::InvalidUpstream)?;
    crate::features::branches::validate_branch_name(repository_path, remote_branch)
        .await
        .map_err(|_| PullError::InvalidUpstream)?;
    let tracking_ref = format!("refs/remotes/{remote_name}/{remote_branch}");
    let tracking_oid = run_git(
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            format!("{tracking_ref}^{{commit}}").into(),
        ],
    )
    .await
    .map_err(|error| match error {
        PullError::GitFailed => PullError::UpstreamGone,
        other => other,
    })?;
    let tracking_oid = text(
        tracking_oid
            .split(|byte| *byte == b'\n')
            .next()
            .unwrap_or_default(),
    )?
    .to_owned();
    let counts = run_git(
        repository_path,
        &[
            "rev-list".into(),
            "--left-right".into(),
            "--count".into(),
            format!("{tracking_ref}...refs/heads/{local_branch}").into(),
        ],
    )
    .await?;
    let counts = std::str::from_utf8(&counts).map_err(|_| PullError::GitFailed)?;
    let mut counts = counts.split_whitespace();
    let behind = counts
        .next()
        .ok_or(PullError::GitFailed)?
        .parse::<u32>()
        .map_err(|_| PullError::GitFailed)?;
    let ahead = counts
        .next()
        .ok_or(PullError::GitFailed)?
        .parse::<u32>()
        .map_err(|_| PullError::GitFailed)?;
    let status = run_git(
        repository_path,
        &[
            "status".into(),
            "--porcelain=v2".into(),
            "-z".into(),
            "--untracked-files=all".into(),
        ],
    )
    .await?;
    let (dirty_paths, omitted_dirty_path_count, has_conflicts) = parse_status(&status)?;
    let operation_in_progress = operation_in_progress(repository_path).await?;
    Ok(PullPreflight {
        repo_id,
        local_branch: local_branch.to_owned(),
        remote_name,
        remote_branch: remote_branch.to_owned(),
        local_oid,
        tracking_oid,
        ahead,
        behind,
        is_clean: dirty_paths.is_empty() && !has_conflicts && !operation_in_progress,
        dirty_paths,
        omitted_dirty_path_count,
        has_conflicts,
        operation_in_progress,
    })
}

async fn operation_in_progress(repository_path: &Path) -> Result<bool, PullError> {
    let git_dir = run_git(repository_path, &["rev-parse".into(), "--git-dir".into()]).await?;
    let git_dir = Path::new(text(&git_dir)?);
    let git_dir = if git_dir.is_absolute() {
        git_dir.to_path_buf()
    } else {
        repository_path.join(git_dir)
    };
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ] {
        if tokio::fs::metadata(git_dir.join(marker)).await.is_ok() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn parse_status(output: &[u8]) -> Result<(Vec<String>, u32, bool), PullError> {
    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut paths = Vec::new();
    let mut has_conflicts = false;
    let mut count = 0u32;
    while let Some(record) = records.next() {
        let value = std::str::from_utf8(record).map_err(|_| PullError::GitFailed)?;
        let path = if let Some(path) = value.strip_prefix("? ") {
            path
        } else if value.starts_with("1 ") {
            value.splitn(9, ' ').nth(8).ok_or(PullError::GitFailed)?
        } else if value.starts_with("2 ") {
            let path = value.splitn(10, ' ').nth(9).ok_or(PullError::GitFailed)?;
            let _original_path = records.next();
            path
        } else if value.starts_with("u ") {
            has_conflicts = true;
            value.splitn(11, ' ').nth(10).ok_or(PullError::GitFailed)?
        } else {
            return Err(PullError::GitFailed);
        };
        count = count.saturating_add(1);
        if paths.len() < MAX_DIRTY_PATHS {
            paths.push(path.to_owned());
        }
    }
    let omitted = count.saturating_sub(paths.len() as u32);
    Ok((paths, omitted, has_conflicts))
}

fn text(bytes: &[u8]) -> Result<&str, PullError> {
    std::str::from_utf8(bytes)
        .map(str::trim)
        .map_err(|_| PullError::GitFailed)
}

async fn run_git(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<Vec<u8>, PullError> {
    let mut command = Command::new("git");
    command
        .current_dir(repository_path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| PullError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(PullError::GitFailed)?;
    let stderr = child.stderr.take().ok_or(PullError::GitFailed)?;
    let stdout_reader = tokio::spawn(read_limited(stdout, MAX_PULL_PREFLIGHT_OUTPUT));
    let stderr_reader = tokio::spawn(read_limited(stderr, 16 * 1024));
    let status = match tokio::time::timeout(PULL_PREFLIGHT_DEADLINE, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            let _ = child.kill().await;
            return Err(PullError::GitFailed);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(PullError::TimedOut);
        }
    };
    let stdout = stdout_reader
        .await
        .map_err(|_| PullError::GitFailed)?
        .map_err(|_| PullError::GitFailed)?;
    let _stderr = stderr_reader
        .await
        .map_err(|_| PullError::GitFailed)?
        .map_err(|_| PullError::GitFailed)?;
    if stdout.len() > MAX_PULL_PREFLIGHT_OUTPUT {
        return Err(PullError::TooLarge);
    }
    if !status.success() {
        return Err(PullError::GitFailed);
    }
    Ok(stdout)
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
    use std::process::Command;

    use super::{operation_in_progress, parse_status};

    #[test]
    fn parses_dirty_paths_and_conflicts_from_porcelain_v2() {
        let output = b"1 .M N... 100644 100644 100644 1111111 1111111 changed.txt\0? untracked.txt\0u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflicted.txt\0";
        let (paths, omitted, conflicts) = parse_status(output).unwrap();
        assert_eq!(paths, ["changed.txt", "untracked.txt", "conflicted.txt"]);
        assert_eq!(omitted, 0);
        assert!(conflicts);
    }

    #[tokio::test]
    async fn detects_an_operation_marker_in_the_repository_git_directory() {
        let directory = tempfile::tempdir().unwrap();
        let output = Command::new("git")
            .arg("init")
            .arg("--quiet")
            .arg(directory.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        let marker = directory.path().join(".git").join("rebase-merge");
        std::fs::create_dir(&marker).unwrap();

        assert!(operation_in_progress(directory.path()).await.unwrap());
    }
}
