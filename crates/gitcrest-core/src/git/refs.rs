use std::{path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::domain::{
    branch::BranchReference,
    error::{GitAdapterError, WorkflowError},
    workflow::{WorkflowBackupNamespace, WorkflowBackupReference, WorkflowRemoteBranchComparison},
};

use super::process::{run_git, text};
use crate::ports::branches::{BranchGitFuture, BranchGitPort};

const MAX_BRANCH_OUTPUT: usize = 8 * 1024 * 1024;
const BRANCH_GIT_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Default)]
pub(crate) struct GitBranchAdapter;

impl BranchGitPort for GitBranchAdapter {
    fn validate_name<'a>(
        &'a self,
        repository_path: &'a Path,
        name: &'a str,
    ) -> BranchGitFuture<'a, bool> {
        Box::pin(async move {
            let output = self
                .run_git(
                    repository_path,
                    &["check-ref-format", "--branch", name],
                    true,
                )
                .await?;
            Ok(output.is_some())
        })
    }

    fn list_references<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> BranchGitFuture<'a, Vec<BranchReference>> {
        Box::pin(async move {
            let output = self
                .run_git(
                    repository_path,
                    &[
                        "for-each-ref",
                        "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(worktreepath)",
                        "refs/heads",
                        "refs/remotes",
                    ],
                    false,
                )
                .await?
                .ok_or(GitAdapterError::Failed)?;
            output
                .split(|byte| *byte == b'\n')
                .filter(|record| !record.is_empty())
                .map(parse_branch_reference)
                .collect()
        })
    }

    fn unmerged_commit_count<'a>(
        &'a self,
        repository_path: &'a Path,
        current: &'a str,
        branch: &'a str,
    ) -> BranchGitFuture<'a, u32> {
        Box::pin(async move {
            let current_ref = normalize_current_ref(current);
            let branch_ref = format!("refs/heads/{branch}");
            let range = format!("{current_ref}..{branch_ref}");
            let output = self
                .run_git(repository_path, &["rev-list", "--count", &range], false)
                .await?
                .ok_or(GitAdapterError::Failed)?;
            std::str::from_utf8(&output)
                .map_err(|_| GitAdapterError::Failed)?
                .trim()
                .parse::<u32>()
                .map_err(|_| GitAdapterError::Failed)
        })
    }

    fn paths_changed_between<'a>(
        &'a self,
        repository_path: &'a Path,
        current: &'a str,
        target: &'a str,
    ) -> BranchGitFuture<'a, Vec<String>> {
        Box::pin(async move {
            let current_ref = normalize_current_ref(current);
            // A full ref such as refs/remotes/origin/feature is used as is; a bare name is a local branch.
            let target_ref = if target.starts_with("refs/") {
                target.to_owned()
            } else {
                format!("refs/heads/{target}")
            };
            let output = self
                .run_git(
                    repository_path,
                    &["diff", "--name-only", "-z", &current_ref, &target_ref],
                    false,
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

fn normalize_current_ref(current: &str) -> String {
    if current.starts_with("refs/") || current.len() == 40 || current.len() == 64 {
        current.to_owned()
    } else {
        format!("refs/heads/{current}")
    }
}

fn parse_branch_reference(record: &[u8]) -> Result<BranchReference, GitAdapterError> {
    let fields = record.splitn(6, |byte| *byte == 0).collect::<Vec<_>>();
    if fields.len() != 6 {
        return Err(GitAdapterError::Failed);
    }
    let full_name = String::from_utf8_lossy(fields[0]).into_owned();
    if !full_name.starts_with("refs/heads/") && !full_name.starts_with("refs/remotes/") {
        return Err(GitAdapterError::Failed);
    }
    let track = String::from_utf8_lossy(fields[4]);
    let worktree_path =
        (!fields[5].is_empty()).then(|| String::from_utf8_lossy(fields[5]).into_owned());
    let (mut ahead, mut behind, upstream_gone) = parse_branch_track(&track)?;
    let upstream = (!fields[3].is_empty()).then(|| String::from_utf8_lossy(fields[3]).into_owned());
    if upstream.is_some() && !upstream_gone && ahead.is_none() && behind.is_none() {
        ahead = Some(0);
        behind = Some(0);
    }
    Ok(BranchReference {
        full_name,
        name: String::from_utf8_lossy(fields[1]).into_owned(),
        oid: String::from_utf8_lossy(fields[2]).into_owned(),
        upstream,
        upstream_gone,
        ahead,
        behind,
        worktree_path,
    })
}

pub(crate) fn parse_branch_track(
    value: &str,
) -> Result<(Option<u32>, Option<u32>, bool), GitAdapterError> {
    if value.is_empty() {
        return Ok((None, None, false));
    }
    let value = value.trim();
    if value == "[gone]" {
        return Ok((None, None, true));
    }
    let value = value
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .ok_or(GitAdapterError::Failed)?;
    let mut ahead = None;
    let mut behind = None;
    for item in value.split(", ") {
        let Some((direction, count)) = item.split_once(' ') else {
            return Err(GitAdapterError::Failed);
        };
        let count = count.parse::<u32>().map_err(|_| GitAdapterError::Failed)?;
        match direction {
            "ahead" => ahead = Some(count),
            "behind" => behind = Some(count),
            _ => return Err(GitAdapterError::Failed),
        }
    }
    Ok((Some(ahead.unwrap_or(0)), Some(behind.unwrap_or(0)), false))
}

impl GitBranchAdapter {
    async fn run_git(
        &self,
        repository_path: &Path,
        arguments: &[&str],
        allow_nonzero: bool,
    ) -> Result<Option<Vec<u8>>, GitAdapterError> {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(repository_path)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| GitAdapterError::Unavailable)?;
        let stdout = child.stdout.take().ok_or(GitAdapterError::Failed)?;
        let stderr = child.stderr.take().ok_or(GitAdapterError::Failed)?;
        let stdout_reader = tokio::spawn(read_branch_output(stdout, MAX_BRANCH_OUTPUT));
        let stderr_reader = tokio::spawn(read_branch_output(stderr, 16 * 1024));
        let status = match tokio::time::timeout(BRANCH_GIT_DEADLINE, child.wait()).await {
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
        let stdout = stdout_reader
            .await
            .map_err(|_| GitAdapterError::Failed)?
            .map_err(|_| GitAdapterError::Failed)?;
        let _stderr = stderr_reader
            .await
            .map_err(|_| GitAdapterError::Failed)?
            .map_err(|_| GitAdapterError::Failed)?;
        if stdout.len() > MAX_BRANCH_OUTPUT {
            return Err(GitAdapterError::OutputTooLarge);
        }
        if status.success() {
            Ok(Some(stdout))
        } else if allow_nonzero {
            Ok(None)
        } else {
            Err(GitAdapterError::Failed)
        }
    }
}

async fn read_branch_output<R>(reader: R, maximum: usize) -> Result<Vec<u8>, std::io::Error>
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

pub(crate) async fn list_backup_references(
    git_program: &str,
    repository_path: &Path,
    namespace: WorkflowBackupNamespace,
) -> Result<Vec<WorkflowBackupReference>, WorkflowError> {
    let references = match namespace {
        WorkflowBackupNamespace::Rebase => "refs/gitcrest/rebase-backups",
        WorkflowBackupNamespace::Reset => "refs/gitcrest/reset-backups",
    };
    let mut arguments = vec!["for-each-ref".into()];
    if namespace == WorkflowBackupNamespace::Reset {
        arguments.push("--count=1000".into());
    }
    arguments.push("--format=%(refname)%00%(objectname)%00%(subject)".into());
    arguments.push(references.into());
    let output = run_git(git_program, repository_path, &arguments).await?;
    let output = text(&output)?;
    output
        .lines()
        .map(|line| {
            let mut fields = line.splitn(3, '\0');
            Ok(WorkflowBackupReference {
                reference: fields.next().ok_or(WorkflowError::GitFailed)?.to_owned(),
                oid: fields.next().ok_or(WorkflowError::GitFailed)?.to_owned(),
                subject: fields.next().ok_or(WorkflowError::GitFailed)?.to_owned(),
            })
        })
        .collect()
}

pub(crate) async fn compare_remote_branch_delete(
    git_program: &str,
    repository_path: &Path,
    current_head_oid: Option<&str>,
    expected_remote_oid: &str,
) -> Result<WorkflowRemoteBranchComparison, WorkflowError> {
    let mut commits_only_on_remote = 0;
    let mut affected_paths = Vec::new();
    if let Some(head_oid) = current_head_oid {
        let count = run_git(
            git_program,
            repository_path,
            &[
                "rev-list".into(),
                "--count".into(),
                format!("{head_oid}..{expected_remote_oid}").into(),
            ],
        )
        .await?;
        commits_only_on_remote = text(&count)?
            .parse()
            .map_err(|_| WorkflowError::GitFailed)?;
        let paths = run_git(
            git_program,
            repository_path,
            &[
                "diff".into(),
                "--name-only".into(),
                "--no-renames".into(),
                "-z".into(),
                head_oid.into(),
                expected_remote_oid.into(),
            ],
        )
        .await?;
        affected_paths = paths
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect();
    }
    Ok(WorkflowRemoteBranchComparison {
        commits_only_on_remote,
        affected_paths,
    })
}
