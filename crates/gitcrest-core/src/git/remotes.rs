use std::{path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::{
    domain::{
        error::GitAdapterError,
        remote::{RemoteConfiguration, RemoteConfigurationSnapshot},
    },
    ports::remotes::{RemoteGitFuture, RemoteGitPort},
};

const MAX_REMOTE_OUTPUT: usize = 8 * 1024 * 1024;
const MAX_CONFIG_OUTPUT: usize = 1024;
const MAX_REMOTES: usize = 128;
const REMOTE_READ_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Default)]
pub(crate) struct GitRemoteAdapter;

impl RemoteGitPort for GitRemoteAdapter {
    fn read_configuration<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemoteGitFuture<'a, RemoteConfigurationSnapshot> {
        Box::pin(async move {
            let list = self
                .run_git(repository_path, &["remote", "-v"], false, MAX_REMOTE_OUTPUT)
                .await?
                .ok_or(GitAdapterError::Failed)?;
            let list = std::str::from_utf8(&list).map_err(|_| GitAdapterError::Failed)?;
            let mut remotes = Vec::<RemoteConfiguration>::new();
            for line in list.lines() {
                let Some((name, value)) = line.split_once('\t') else {
                    return Err(GitAdapterError::Failed);
                };
                let (url, direction) = value.rsplit_once(" (").ok_or(GitAdapterError::Failed)?;
                let direction = direction.strip_suffix(')').ok_or(GitAdapterError::Failed)?;
                let index = match remotes.iter().position(|remote| remote.name == name) {
                    Some(index) => index,
                    None if remotes.len() < MAX_REMOTES => {
                        remotes.push(RemoteConfiguration {
                            name: name.to_owned(),
                            fetch_urls: Vec::new(),
                            push_urls: Vec::new(),
                        });
                        remotes.len() - 1
                    }
                    None => return Err(GitAdapterError::OutputTooLarge),
                };
                match direction {
                    "fetch" => remotes[index].fetch_urls.push(url.to_owned()),
                    "push" => remotes[index].push_urls.push(url.to_owned()),
                    _ => return Err(GitAdapterError::Failed),
                }
            }
            let configured_default = match self
                .run_git(
                    repository_path,
                    &["config", "--local", "--get", "gitcrest.defaultRemote"],
                    true,
                    MAX_CONFIG_OUTPUT,
                )
                .await?
            {
                Some(output) => {
                    let value = String::from_utf8_lossy(&output).trim().to_owned();
                    (!value.is_empty()).then_some(value)
                }
                None => None,
            };
            Ok(RemoteConfigurationSnapshot {
                remotes,
                configured_default,
            })
        })
    }

    fn validate_name<'a>(
        &'a self,
        repository_path: &'a Path,
        name: &'a str,
    ) -> RemoteGitFuture<'a, bool> {
        Box::pin(async move {
            let reference = format!("refs/remotes/{name}/HEAD");
            self.run_git(
                repository_path,
                &["check-ref-format", &reference],
                true,
                1024,
            )
            .await
            .map(|output| output.is_some())
        })
    }
}

impl GitRemoteAdapter {
    async fn run_git(
        &self,
        repository_path: &Path,
        arguments: &[&str],
        allow_nonzero: bool,
        maximum_output: usize,
    ) -> Result<Option<Vec<u8>>, GitAdapterError> {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(repository_path)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| GitAdapterError::Unavailable)?;
        let stdout = child.stdout.take().ok_or(GitAdapterError::Failed)?;
        let reader = tokio::spawn(read_limited(stdout, maximum_output));
        let status = match tokio::time::timeout(REMOTE_READ_DEADLINE, child.wait()).await {
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
        let output = reader
            .await
            .map_err(|_| GitAdapterError::Failed)?
            .map_err(|_| GitAdapterError::Failed)?;
        if output.len() > maximum_output {
            return Err(GitAdapterError::OutputTooLarge);
        }
        if status.success() {
            Ok(Some(output))
        } else if allow_nonzero && status.code() == Some(1) {
            Ok(None)
        } else {
            Err(GitAdapterError::Failed)
        }
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
