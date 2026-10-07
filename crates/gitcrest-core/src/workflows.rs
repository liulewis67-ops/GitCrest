use std::{path::Path, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const MAX_PREFLIGHT_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_PATHS: usize = 200;
const PREFLIGHT_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowAction {
    Merge,
    CherryPick,
    Revert,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowOperation {
    Merge,
    CherryPick,
    Revert,
    Rebase,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPreflight {
    pub repo_id: String,
    pub action: WorkflowAction,
    pub head_oid: Option<String>,
    pub target_oid: String,
    pub target_subject: String,
    pub operation_in_progress: Option<WorkflowOperation>,
    pub is_clean: bool,
    pub dirty_paths: Vec<String>,
    pub omitted_dirty_path_count: u32,
    pub conflicted_paths: Vec<String>,
    pub omitted_conflicted_path_count: u32,
    pub can_start: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WorkflowError {
    InvalidTarget,
    CommitNotFound,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
}

pub async fn read_preflight(
    repo_id: String,
    repository_path: &Path,
    action: WorkflowAction,
    target: &str,
) -> Result<WorkflowPreflight, WorkflowError> {
    if !(4..=64).contains(&target.len()) || !target.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorkflowError::InvalidTarget);
    }
    let target_oid = run_git(
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "--end-of-options".into(),
            format!("{target}^{{commit}}").into(),
        ],
    )
    .await
    .map_err(|error| match error {
        WorkflowError::GitFailed => WorkflowError::CommitNotFound,
        other => other,
    })?;
    let target_oid = text(&target_oid)?.to_owned();
    let target_subject = text(
        &run_git(
            repository_path,
            &[
                "show".into(),
                "-s".into(),
                "--format=%s".into(),
                target_oid.clone().into(),
            ],
        )
        .await?,
    )?
    .to_owned();
    let head = run_git_optional(
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "HEAD^{commit}".into(),
        ],
    )
    .await?;
    let head_oid = head.as_deref().map(text).transpose()?.map(str::to_owned);
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
    let operation_in_progress = read_operation(repository_path).await?;
    let is_clean = dirty_paths.is_empty() && operation_in_progress.is_none();
    let can_start = head_oid.is_some() && is_clean;
    Ok(WorkflowPreflight {
        repo_id,
        action,
        head_oid,
        target_oid,
        target_subject,
        operation_in_progress,
        is_clean,
        dirty_paths,
        omitted_dirty_path_count,
        conflicted_paths,
        omitted_conflicted_path_count,
        can_start,
    })
}

async fn read_operation(
    repository_path: &Path,
) -> Result<Option<WorkflowOperation>, WorkflowError> {
    let git_dir = run_git(repository_path, &["rev-parse".into(), "--git-dir".into()]).await?;
    let git_dir = Path::new(text(&git_dir)?);
    let git_dir = if git_dir.is_absolute() {
        git_dir.to_path_buf()
    } else {
        repository_path.join(git_dir)
    };
    for (marker, operation) in [
        ("MERGE_HEAD", WorkflowOperation::Merge),
        ("CHERRY_PICK_HEAD", WorkflowOperation::CherryPick),
        ("REVERT_HEAD", WorkflowOperation::Revert),
    ] {
        if tokio::fs::metadata(git_dir.join(marker)).await.is_ok() {
            return Ok(Some(operation));
        }
    }
    for marker in ["rebase-merge", "rebase-apply"] {
        if tokio::fs::metadata(git_dir.join(marker)).await.is_ok() {
            return Ok(Some(WorkflowOperation::Rebase));
        }
    }
    Ok(None)
}

fn parse_status(output: &[u8]) -> Result<(Vec<String>, u32, Vec<String>, u32), WorkflowError> {
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

fn text(bytes: &[u8]) -> Result<&str, WorkflowError> {
    std::str::from_utf8(bytes)
        .map(str::trim)
        .map_err(|_| WorkflowError::GitFailed)
}

async fn run_git(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<Vec<u8>, WorkflowError> {
    run_git_inner(repository_path, arguments, false)
        .await?
        .ok_or(WorkflowError::GitFailed)
}

async fn run_git_optional(
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

#[cfg(test)]
mod tests {
    use std::process::Command;

    use tempfile::tempdir;

    use super::{parse_status, read_preflight, WorkflowAction, WorkflowOperation};

    #[test]
    fn parses_worktree_and_conflict_paths_with_a_bounded_list() {
        let mut status = b"1 .M N... 100644 100644 100644 1111111 1111111 dirty.txt\0u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.txt\0".to_vec();
        for index in 0..205 {
            status.extend_from_slice(format!("? path-{index}.txt\0").as_bytes());
        }
        let (dirty, omitted_dirty, conflicted, omitted_conflicted) = parse_status(&status).unwrap();
        assert_eq!(dirty.len(), 200);
        assert_eq!(omitted_dirty, 7);
        assert_eq!(conflicted, ["conflict.txt"]);
        assert_eq!(omitted_conflicted, 0);
    }

    #[tokio::test]
    async fn preflight_resolves_commit_targets_and_reports_dirty_and_active_operations() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let git = |arguments: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(root)
                .args(arguments)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "user.name", "GitCrest Test"]);
        git(&["config", "user.email", "test@example.test"]);
        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        git(&["add", "base.txt"]);
        git(&["commit", "--quiet", "-m", "base commit"]);
        let oid = String::from_utf8(git(&["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .to_owned();

        let clean = read_preflight("repo_fixture".into(), root, WorkflowAction::Merge, &oid)
            .await
            .unwrap();
        assert!(clean.can_start);
        assert_eq!(clean.head_oid.as_deref(), Some(oid.as_str()));
        assert_eq!(clean.target_oid, oid);
        assert_eq!(clean.target_subject, "base commit");

        std::fs::write(root.join("dirty.txt"), "local edit\n").unwrap();
        let dirty = read_preflight(
            "repo_fixture".into(),
            root,
            WorkflowAction::CherryPick,
            &oid,
        )
        .await
        .unwrap();
        assert!(!dirty.can_start);
        assert_eq!(dirty.dirty_paths, ["dirty.txt"]);

        std::fs::remove_file(root.join("dirty.txt")).unwrap();
        git(&["checkout", "--quiet", "-b", "side"]);
        std::fs::write(root.join("base.txt"), "side\n").unwrap();
        git(&["commit", "--quiet", "-am", "side commit"]);
        git(&["checkout", "--quiet", "main"]);
        std::fs::write(root.join("base.txt"), "main\n").unwrap();
        git(&["commit", "--quiet", "-am", "main commit"]);
        let conflict = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["merge", "side"])
            .output()
            .unwrap();
        assert!(!conflict.status.success());
        let side_oid = String::from_utf8(git(&["rev-parse", "side"]))
            .unwrap()
            .trim()
            .to_owned();
        let active = read_preflight(
            "repo_fixture".into(),
            root,
            WorkflowAction::Revert,
            &side_oid,
        )
        .await
        .unwrap();
        assert!(!active.can_start);
        assert_eq!(active.operation_in_progress, Some(WorkflowOperation::Merge));
        assert_eq!(active.conflicted_paths, ["base.txt"]);
    }
}
