use std::{path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::domain::{
    error::WorkflowError,
    workflow::{
        WorkflowBackupNamespace, WorkflowBackupReference, WorkflowCommitSubject, WorkflowOperation,
        WorkflowRebaseCommitList, WorkflowRemoteBranchComparison, WorkflowResetComparison,
        WorkflowState,
    },
};
use tokio::{sync::Semaphore, task::JoinSet};

const MAX_PREFLIGHT_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_PATHS: usize = 200;
const PREFLIGHT_DEADLINE: Duration = Duration::from_secs(20);
const MAX_REBASE_COMMITS: usize = 200;

pub(crate) async fn list_backup_references(
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
    let output = run_git(repository_path, &arguments).await?;
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

pub(crate) async fn compare_for_reset(
    repository_path: &Path,
    head_oid: &str,
    target_oid: &str,
) -> Result<WorkflowResetComparison, WorkflowError> {
    let counts = run_git(
        repository_path,
        &[
            "rev-list".into(),
            "--left-right".into(),
            "--count".into(),
            format!("{head_oid}...{target_oid}").into(),
        ],
    )
    .await?;
    let (commits_removed, commits_added) = text(&counts)?
        .split_once('\t')
        .and_then(|(left, right)| Some((left.parse().ok()?, right.parse().ok()?)))
        .ok_or(WorkflowError::GitFailed)?;
    let paths = run_git(
        repository_path,
        &[
            "diff".into(),
            "--name-only".into(),
            "--no-renames".into(),
            format!("{head_oid}..{target_oid}").into(),
            "--".into(),
        ],
    )
    .await?;
    let changed_paths = text(&paths)?
        .lines()
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(WorkflowResetComparison {
        commits_removed,
        commits_added,
        changed_paths,
    })
}

pub(crate) async fn list_rebase_commits(
    repository_path: &Path,
    onto_oid: &str,
    head_oid: &str,
) -> Result<WorkflowRebaseCommitList, WorkflowError> {
    let range = format!("{onto_oid}..{head_oid}");
    let output = run_git(
        repository_path,
        &[
            "log".into(),
            "--reverse".into(),
            "--topo-order".into(),
            "--format=%H%x00%s".into(),
            "-n".into(),
            (MAX_REBASE_COMMITS + 1).to_string().into(),
            "--no-show-signature".into(),
            range.into(),
        ],
    )
    .await?;
    let mut commits = Vec::new();
    let mut omitted_commit_count = 0;
    for line in text(&output)?.lines().filter(|line| !line.is_empty()) {
        let (oid, subject) = line.split_once('\0').ok_or(WorkflowError::GitFailed)?;
        if commits.len() == MAX_REBASE_COMMITS {
            omitted_commit_count += 1;
            continue;
        }
        commits.push(WorkflowCommitSubject {
            oid: oid.trim().to_owned(),
            subject: subject.trim().to_owned(),
        });
    }

    let mut checks = JoinSet::new();
    let semaphore = std::sync::Arc::new(Semaphore::new(8));
    for commit in &commits {
        let oid = commit.oid.clone();
        let path = repository_path.to_path_buf();
        let semaphore = semaphore.clone();
        checks.spawn(async move {
            let permit = semaphore
                .acquire_owned()
                .await
                .map_err(|_| WorkflowError::GitFailed)?;
            let refs = run_git(
                &path,
                &[
                    "for-each-ref".into(),
                    "--format=%(refname)".into(),
                    "--contains".into(),
                    oid.clone().into(),
                    "refs/remotes".into(),
                ],
            )
            .await;
            drop(permit);
            refs.and_then(|refs| text(&refs).map(|refs| (oid, !refs.is_empty())))
        });
    }
    let mut published_commit_oids = Vec::new();
    while let Some(result) = checks.join_next().await {
        let (oid, is_published) = result.map_err(|_| WorkflowError::GitFailed)??;
        if is_published {
            published_commit_oids.push(oid);
        }
    }
    published_commit_oids.sort();
    Ok(WorkflowRebaseCommitList {
        commits,
        omitted_commit_count,
        published_commit_oids,
    })
}

pub(crate) async fn compare_remote_branch_delete(
    repository_path: &Path,
    current_head_oid: Option<&str>,
    expected_remote_oid: &str,
) -> Result<WorkflowRemoteBranchComparison, WorkflowError> {
    let mut commits_only_on_remote = 0;
    let mut affected_paths = Vec::new();
    if let Some(head_oid) = current_head_oid {
        let count = run_git(
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
pub(crate) async fn read_worktree_state(
    repository_path: &Path,
) -> Result<WorkflowState, WorkflowError> {
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
    Ok(WorkflowState {
        dirty_paths,
        omitted_dirty_path_count,
        conflicted_paths,
        omitted_conflicted_path_count,
        operation,
    })
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

pub(crate) async fn resolve_commit_target(
    repository_path: &Path,
    target: &str,
) -> Result<String, WorkflowError> {
    let output = run_git(
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "--end-of-options".into(),
            format!("{target}^{{commit}}").into(),
        ],
    )
    .await?;
    Ok(text(&output)?.to_owned())
}

pub(crate) async fn read_commit_subject(
    repository_path: &Path,
    target_oid: &str,
) -> Result<String, WorkflowError> {
    let output = run_git(
        repository_path,
        &[
            "show".into(),
            "-s".into(),
            "--format=%s".into(),
            target_oid.into(),
        ],
    )
    .await?;
    Ok(text(&output)?.to_owned())
}

pub(crate) async fn read_head_oid(repository_path: &Path) -> Result<Option<String>, WorkflowError> {
    run_git_optional(
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "HEAD^{commit}".into(),
        ],
    )
    .await?
    .as_deref()
    .map(text)
    .transpose()
    .map(|head| head.map(str::to_owned))
}

pub(crate) async fn read_current_branch(
    repository_path: &Path,
) -> Result<Option<String>, WorkflowError> {
    run_git_optional(
        repository_path,
        &[
            "symbolic-ref".into(),
            "--quiet".into(),
            "--short".into(),
            "HEAD".into(),
        ],
    )
    .await?
    .as_deref()
    .map(text)
    .transpose()
    .map(|branch| branch.map(str::to_owned))
}

pub(crate) fn parse_status(
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
