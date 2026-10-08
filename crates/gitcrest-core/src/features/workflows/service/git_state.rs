use std::{path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::domain::{error::WorkflowError, workflow::WorkflowOperation};

const MAX_PREFLIGHT_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_PATHS: usize = 200;
const PREFLIGHT_DEADLINE: Duration = Duration::from_secs(20);
pub(crate) async fn read_worktree_state(
    repository_path: &Path,
) -> Result<
    (
        Vec<String>,
        u32,
        Vec<String>,
        u32,
        Option<WorkflowOperation>,
    ),
    WorkflowError,
> {
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
    let (dirty_paths, omitted_dirty_path_count, conflicted_paths, omitted_conflicted_path_count) =
        parse_status(&status)?;
    let operation = read_operation(repository_path).await?;
    Ok((
        dirty_paths,
        omitted_dirty_path_count,
        conflicted_paths,
        omitted_conflicted_path_count,
        operation,
    ))
}

pub(crate) async fn read_operation(
    repository_path: &Path,
) -> Result<Option<WorkflowOperation>, WorkflowError> {
    let git_dir = run_git(repository_path, &["rev-parse".into(), "--git-dir".into()]).await?;
    let git_dir = Path::new(text(&git_dir)?);
    let git_dir = if git_dir.is_absolute() {
        git_dir.to_path_buf()
    } else {
        repository_path.join(git_dir)
    };
    for marker in ["rebase-merge", "rebase-apply"] {
        if tokio::fs::metadata(git_dir.join(marker)).await.is_ok() {
            return Ok(Some(WorkflowOperation::Rebase));
        }
    }
    for (marker, operation) in [
        ("MERGE_HEAD", WorkflowOperation::Merge),
        ("CHERRY_PICK_HEAD", WorkflowOperation::CherryPick),
        ("REVERT_HEAD", WorkflowOperation::Revert),
    ] {
        if tokio::fs::metadata(git_dir.join(marker)).await.is_ok() {
            return Ok(Some(operation));
        }
    }
    Ok(None)
}

pub(super) fn parse_status(
    output: &[u8],
) -> Result<(Vec<String>, u32, Vec<String>, u32), WorkflowError> {
    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut dirty_paths = Vec::new();
    let mut conflicted_paths = Vec::new();
    let mut dirty_count = 0u32;
    let mut conflicted_count = 0u32;
    while let Some(record) = records.next() {
        let value = std::str::from_utf8(record).map_err(|_| WorkflowError::GitFailed)?;
        let (path, conflicted) = if let Some(path) = value.strip_prefix("? ") {
            (path, false)
        } else if value.starts_with("1 ") {
            (
                value
                    .splitn(9, ' ')
                    .nth(8)
                    .ok_or(WorkflowError::GitFailed)?,
                false,
            )
        } else if value.starts_with("2 ") {
            let path = value
                .splitn(10, ' ')
                .nth(9)
                .ok_or(WorkflowError::GitFailed)?;
            let _original_path = records.next();
            (path, false)
        } else if value.starts_with("u ") {
            (
                value
                    .splitn(11, ' ')
                    .nth(10)
                    .ok_or(WorkflowError::GitFailed)?,
                true,
            )
        } else {
            return Err(WorkflowError::GitFailed);
        };
        dirty_count = dirty_count.saturating_add(1);
        if dirty_paths.len() < MAX_PATHS {
            dirty_paths.push(path.to_owned());
        }
        if conflicted {
            conflicted_count = conflicted_count.saturating_add(1);
            if conflicted_paths.len() < MAX_PATHS {
                conflicted_paths.push(path.to_owned());
            }
        }
    }
    Ok((
        dirty_paths,
        dirty_count.saturating_sub(MAX_PATHS as u32),
        conflicted_paths,
        conflicted_count.saturating_sub(MAX_PATHS as u32),
    ))
}

pub(super) fn text(bytes: &[u8]) -> Result<&str, WorkflowError> {
    std::str::from_utf8(bytes)
        .map(str::trim)
        .map_err(|_| WorkflowError::GitFailed)
}

pub(super) async fn run_git(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<Vec<u8>, WorkflowError> {
    run_git_inner(repository_path, arguments, false)
        .await?
        .ok_or(WorkflowError::GitFailed)
}

pub(super) async fn run_git_optional(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<Option<Vec<u8>>, WorkflowError> {
    run_git_inner(repository_path, arguments, true).await
}

async fn run_git_inner(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
    allow_nonzero: bool,
) -> Result<Option<Vec<u8>>, WorkflowError> {
    let mut command = Command::new("git");
    command
        .current_dir(repository_path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| WorkflowError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(WorkflowError::GitFailed)?;
    let stderr = child.stderr.take().ok_or(WorkflowError::GitFailed)?;
    let stdout_reader = tokio::spawn(read_limited(stdout, MAX_PREFLIGHT_OUTPUT));
    let stderr_reader = tokio::spawn(read_limited(stderr, 16 * 1024));
    let status = match tokio::time::timeout(PREFLIGHT_DEADLINE, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            let _ = child.kill().await;
            return Err(WorkflowError::GitFailed);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(WorkflowError::TimedOut);
        }
    };
    let stdout = stdout_reader
        .await
        .map_err(|_| WorkflowError::GitFailed)?
        .map_err(|_| WorkflowError::GitFailed)?;
    let _stderr = stderr_reader
        .await
        .map_err(|_| WorkflowError::GitFailed)?
        .map_err(|_| WorkflowError::GitFailed)?;
    if stdout.len() > MAX_PREFLIGHT_OUTPUT {
        return Err(WorkflowError::TooLarge);
    }
    if status.success() {
        Ok(Some(stdout))
    } else if allow_nonzero {
        Ok(None)
    } else {
        Err(WorkflowError::GitFailed)
    }
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
