use std::{path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

use crate::{
    domain::error::GitAdapterError,
    ports::tags::{TagGitFuture, TagGitPort},
};

const TAG_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const TAG_OUTPUT_LIMIT: usize = 16 * 1024;

#[derive(Clone, Copy, Default)]
pub(crate) struct GitTagAdapter;

impl TagGitPort for GitTagAdapter {
    fn check_ref_name<'a>(
        &'a self,
        repository_path: &'a Path,
        full_name: &'a str,
    ) -> TagGitFuture<'a, bool> {
        Box::pin(async move {
            let output = self
                .run_git(repository_path, &["check-ref-format", full_name], None)
                .await?;
            Ok(output.success)
        })
    }

    fn object_is_commit<'a>(
        &'a self,
        repository_path: &'a Path,
        oid: &'a str,
    ) -> TagGitFuture<'a, bool> {
        Box::pin(async move {
            let output = self
                .run_git(repository_path, &["cat-file", "-t", oid], None)
                .await?;
            Ok(output.success && output.stdout.trim() == "commit")
        })
    }

    fn list_tag_names<'a>(&'a self, repository_path: &'a Path) -> TagGitFuture<'a, Vec<String>> {
        Box::pin(async move {
            let output = self
                .run_git(
                    repository_path,
                    &["for-each-ref", "--format=%(refname)", "refs/tags"],
                    None,
                )
                .await?;
            if !output.success {
                return Err(GitAdapterError::Failed);
            }
            Ok(output.stdout.lines().map(str::to_owned).collect())
        })
    }

    fn create_annotated_tag<'a>(
        &'a self,
        repository_path: &'a Path,
        name: &'a str,
        oid: &'a str,
        message: &'a str,
    ) -> TagGitFuture<'a, ()> {
        Box::pin(async move {
            let output = self
                .run_git(
                    repository_path,
                    &["tag", "--annotate", "--file=-", "--", name, oid],
                    Some(message.as_bytes()),
                )
                .await?;
            if output.success {
                return Ok(());
            }
            if output
                .stderr
                .to_ascii_lowercase()
                .contains("already exists")
            {
                Err(GitAdapterError::ReferenceAlreadyExists)
            } else {
                Err(GitAdapterError::Failed)
            }
        })
    }
}

struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

impl GitTagAdapter {
    async fn run_git(
        &self,
        repository_path: &Path,
        arguments: &[&str],
        input: Option<&[u8]>,
    ) -> Result<GitOutput, GitAdapterError> {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(repository_path)
            .args(arguments)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(if arguments.first() == Some(&"tag") {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| GitAdapterError::Unavailable)?;
        let stdout = child.stdout.take().ok_or(GitAdapterError::Failed)?;
        let stdout_reader = tokio::spawn(read_limited(stdout));
        let stderr_reader = child
            .stderr
            .take()
            .map(|stderr| tokio::spawn(read_limited(stderr)));
        let writer = if let Some(input) = input {
            let mut stdin = child.stdin.take().ok_or(GitAdapterError::Failed)?;
            let input = input.to_vec();
            Some(tokio::spawn(async move {
                stdin.write_all(&input).await?;
                stdin.shutdown().await
            }))
        } else {
            None
        };
        let status = match tokio::time::timeout(TAG_COMMAND_TIMEOUT, child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(_)) => {
                let _ = child.kill().await;
                return Err(GitAdapterError::Failed);
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err(GitAdapterError::TimedOut);
            }
        };
        if let Some(writer) = writer {
            writer
                .await
                .map_err(|_| GitAdapterError::Failed)?
                .map_err(|_| GitAdapterError::Failed)?;
        }
        let stdout = stdout_reader
            .await
            .map_err(|_| GitAdapterError::Failed)?
            .map_err(|_| GitAdapterError::Failed)?;
        let stderr = match stderr_reader {
            Some(reader) => reader
                .await
                .map_err(|_| GitAdapterError::Failed)?
                .map_err(|_| GitAdapterError::Failed)?,
            None => Vec::new(),
        };
        if stdout.len() > TAG_OUTPUT_LIMIT || stderr.len() > TAG_OUTPUT_LIMIT {
            return Err(GitAdapterError::OutputTooLarge);
        }
        Ok(GitOutput {
            success: status.success(),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }
}

async fn read_limited<R>(stream: R) -> std::io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::with_capacity(TAG_OUTPUT_LIMIT.min(16 * 1024));
    stream
        .take((TAG_OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut output)
        .await?;
    Ok(output)
}
