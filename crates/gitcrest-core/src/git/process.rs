use std::{path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::domain::error::WorkflowError;

const MAX_PREFLIGHT_OUTPUT: usize = 2 * 1024 * 1024;
const PREFLIGHT_DEADLINE: Duration = Duration::from_secs(20);
pub(super) fn text(bytes: &[u8]) -> Result<&str, WorkflowError> {
    std::str::from_utf8(bytes)
        .map(str::trim)
        .map_err(|_| WorkflowError::GitFailed)
}

pub(super) async fn run_git(
    git_program: &str,
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<Vec<u8>, WorkflowError> {
    run_git_inner(git_program, repository_path, arguments, false)
        .await?
        .ok_or(WorkflowError::GitFailed)
}

pub(super) async fn run_git_optional(
    git_program: &str,
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<Option<Vec<u8>>, WorkflowError> {
    run_git_inner(git_program, repository_path, arguments, true).await
}

async fn run_git_inner(
    git_program: &str,
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
    allow_nonzero: bool,
) -> Result<Option<Vec<u8>>, WorkflowError> {
    let mut command = Command::new(git_program);
    command
        .current_dir(repository_path)
        .args(arguments)
        .env("GIT_NO_LAZY_FETCH", "1")
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
