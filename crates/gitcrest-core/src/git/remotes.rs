use std::{path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::{
    domain::{
        error::GitAdapterError,
        remote::{
            RemoteBranchCommit, RemoteBranchDivergence, RemoteBranchUpstream, RemoteConfiguration,
            RemoteConfigurationSnapshot,
        },
    },
    ports::remotes::{RemoteGitFuture, RemoteGitPort},
};

const MAX_REMOTE_OUTPUT: usize = 8 * 1024 * 1024;
const MAX_CONFIG_OUTPUT: usize = 1024;
const MAX_PREFLIGHT_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_PUSH_PREVIEW_COMMITS: usize = 50;
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

    fn read_branch_upstream<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
    ) -> RemoteGitFuture<'a, RemoteBranchUpstream> {
        Box::pin(async move {
            let reference = format!("refs/heads/{local_branch}");
            let output = self
                .run_git(
                    repository_path,
                    &[
                        "for-each-ref",
                        "--format=%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)",
                        &reference,
                    ],
                    false,
                    MAX_PREFLIGHT_OUTPUT,
                )
                .await?
                .ok_or(GitAdapterError::Failed)?;
            let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
            if fields.len() < 3 {
                return Err(GitAdapterError::Failed);
            }
            let parse_field = |field: &[u8]| {
                std::str::from_utf8(field)
                    .map(str::trim)
                    .map(str::to_owned)
                    .map_err(|_| GitAdapterError::Failed)
            };
            Ok(RemoteBranchUpstream {
                local_oid: parse_field(fields[0])?,
                remote_name: parse_field(fields[1])?,
                remote_ref: parse_field(fields[2])?,
            })
        })
    }

    fn resolve_tracking_commit<'a>(
        &'a self,
        repository_path: &'a Path,
        remote_name: &'a str,
        remote_branch: &'a str,
    ) -> RemoteGitFuture<'a, Option<String>> {
        Box::pin(async move {
            let tracking_ref = format!("refs/remotes/{remote_name}/{remote_branch}");
            let target = format!("{tracking_ref}^{{commit}}");
            let output = self
                .run_git(
                    repository_path,
                    &["rev-parse", "--verify", &target],
                    true,
                    MAX_PREFLIGHT_OUTPUT,
                )
                .await?;
            output
                .map(|output| {
                    std::str::from_utf8(
                        output
                            .split(|byte| *byte == b'\n')
                            .next()
                            .unwrap_or_default(),
                    )
                    .map(str::trim)
                    .map(str::to_owned)
                    .map_err(|_| GitAdapterError::Failed)
                })
                .transpose()
        })
    }

    fn compare_tracking_branch<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
        remote_name: &'a str,
        remote_branch: &'a str,
    ) -> RemoteGitFuture<'a, RemoteBranchDivergence> {
        Box::pin(async move {
            let tracking_ref = format!("refs/remotes/{remote_name}/{remote_branch}");
            let local_ref = format!("refs/heads/{local_branch}");
            let range = format!("{tracking_ref}...{local_ref}");
            let output = self
                .run_git(
                    repository_path,
                    &["rev-list", "--left-right", "--count", &range],
                    false,
                    MAX_PREFLIGHT_OUTPUT,
                )
                .await?
                .ok_or(GitAdapterError::Failed)?;
            let counts = std::str::from_utf8(&output).map_err(|_| GitAdapterError::Failed)?;
            let mut counts = counts.split_whitespace();
            let behind = counts
                .next()
                .ok_or(GitAdapterError::Failed)?
                .parse::<u32>()
                .map_err(|_| GitAdapterError::Failed)?;
            let ahead = counts
                .next()
                .ok_or(GitAdapterError::Failed)?
                .parse::<u32>()
                .map_err(|_| GitAdapterError::Failed)?;
            Ok(RemoteBranchDivergence { ahead, behind })
        })
    }

    fn resolve_local_commit<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
    ) -> RemoteGitFuture<'a, String> {
        Box::pin(async move {
            let reference = format!("refs/heads/{local_branch}^{{commit}}");
            let output = self
                .run_git(
                    repository_path,
                    &["rev-parse", "--verify", &reference],
                    false,
                    MAX_PREFLIGHT_OUTPUT,
                )
                .await?
                .ok_or(GitAdapterError::Failed)?;
            std::str::from_utf8(&output)
                .map(str::trim)
                .map(str::to_owned)
                .map_err(|_| GitAdapterError::Failed)
        })
    }

    fn list_commits_to_push<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
        remote_name: &'a str,
        remote_branch: &'a str,
    ) -> RemoteGitFuture<'a, Vec<RemoteBranchCommit>> {
        Box::pin(async move {
            let tracking_ref = format!("refs/remotes/{remote_name}/{remote_branch}");
            let local_ref = format!("refs/heads/{local_branch}");
            let range = format!("{tracking_ref}..{local_ref}");
            let limit = format!("-n{MAX_PUSH_PREVIEW_COMMITS}");
            let output = self
                .run_git(
                    repository_path,
                    &["log", "--format=%H%x00%s", &limit, &range],
                    false,
                    MAX_PREFLIGHT_OUTPUT,
                )
                .await?
                .ok_or(GitAdapterError::Failed)?;
            std::str::from_utf8(&output)
                .map_err(|_| GitAdapterError::Failed)?
                .lines()
                .map(|line| {
                    let (oid, subject) = line.split_once('\0').ok_or(GitAdapterError::Failed)?;
                    Ok(RemoteBranchCommit {
                        oid: oid.to_owned(),
                        subject: subject.to_owned(),
                    })
                })
                .collect()
        })
    }

    fn list_changed_paths_to_push<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
        remote_name: &'a str,
        remote_branch: &'a str,
    ) -> RemoteGitFuture<'a, Vec<String>> {
        Box::pin(async move {
            let tracking_ref = format!("refs/remotes/{remote_name}/{remote_branch}");
            let local_ref = format!("refs/heads/{local_branch}");
            let output = self
                .run_git(
                    repository_path,
                    &[
                        "diff",
                        "--name-only",
                        "-z",
                        "--no-renames",
                        &tracking_ref,
                        &local_ref,
                    ],
                    false,
                    MAX_PREFLIGHT_OUTPUT,
                )
                .await?
                .ok_or(GitAdapterError::Failed)?;
            Ok(output
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .map(|path| String::from_utf8_lossy(path).into_owned())
                .collect())
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
