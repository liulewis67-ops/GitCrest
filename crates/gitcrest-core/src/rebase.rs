use std::{path::Path, process::Stdio, time::Duration};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{io::AsyncReadExt, process::Command};

use crate::workflows::{read_worktree_state, WorkflowError, WorkflowOperation};

const MAX_COMMITS: usize = 200;
const PREFLIGHT_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub oid: String,
    pub subject: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePreview {
    pub repo_id: String,
    pub head_oid: Option<String>,
    pub onto_oid: String,
    pub current_branch: Option<String>,
    pub commits: Vec<RebaseCommit>,
    pub omitted_commit_count: u32,
    pub dirty_paths: Vec<String>,
    pub omitted_dirty_path_count: u32,
    pub operation_in_progress: Option<WorkflowOperation>,
    pub preview_revision: String,
    pub can_start: bool,
}

pub async fn read_preview(
    repo_id: String,
    repository_path: &Path,
    onto: &str,
) -> Result<RebasePreview, WorkflowError> {
    if !(4..=64).contains(&onto.len()) || !onto.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorkflowError::InvalidTarget);
    }
    let onto_oid = run_git(
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "--end-of-options".into(),
            format!("{onto}^{{commit}}").into(),
        ],
    )
    .await?
    .trim()
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
    let head_oid = head.map(|value| String::from_utf8_lossy(&value).trim().to_owned());
    let branch = run_git_optional(
        repository_path,
        &[
            "symbolic-ref".into(),
            "--quiet".into(),
            "--short".into(),
            "HEAD".into(),
        ],
    )
    .await?;
    let current_branch = branch.map(|value| String::from_utf8_lossy(&value).trim().to_owned());

    let mut commits = Vec::new();
    let mut omitted_commit_count = 0;
    if head_oid.is_some() {
        let range = format!("{onto_oid}..HEAD");
        let output = run_git(
            repository_path,
            &[
                "log".into(),
                "--reverse".into(),
                "--topo-order".into(),
                "--format=%H%x00%s".into(),
                "-n".into(),
                (MAX_COMMITS + 1).to_string().into(),
                "--no-show-signature".into(),
                range.into(),
            ],
        )
        .await?;
        for line in output.lines().filter(|line| !line.is_empty()) {
            let (oid, subject) = line.split_once('\0').ok_or(WorkflowError::GitFailed)?;
            if commits.len() == MAX_COMMITS {
                omitted_commit_count += 1;
                continue;
            }
            commits.push(RebaseCommit {
                oid: oid.trim().to_owned(),
                subject: subject.trim().to_owned(),
            });
        }
    }
    let (dirty_paths, omitted_dirty_path_count, _, _, operation_in_progress) =
        read_worktree_state(repository_path).await?;
    let can_start = head_oid.is_some()
        && current_branch.is_some()
        && onto_oid != head_oid.as_deref().unwrap_or_default()
        && !commits.is_empty()
        && omitted_commit_count == 0
        && dirty_paths.is_empty()
        && operation_in_progress.is_none();
    let mut digest = Sha256::new();
    digest.update(repo_id.as_bytes());
    digest.update([0]);
    digest.update(head_oid.as_deref().unwrap_or_default().as_bytes());
    digest.update([0]);
    digest.update(onto_oid.as_bytes());
    digest.update([0]);
    for commit in &commits {
        digest.update(commit.oid.as_bytes());
        digest.update([0]);
        digest.update(commit.subject.as_bytes());
        digest.update([0]);
    }
    for path in &dirty_paths {
        digest.update(path.as_bytes());
        digest.update([0]);
    }
    Ok(RebasePreview {
        repo_id,
        head_oid,
        onto_oid,
        current_branch,
        commits,
        omitted_commit_count,
        dirty_paths,
        omitted_dirty_path_count,
        operation_in_progress,
        preview_revision: format!("sha256:{:x}", digest.finalize()),
        can_start,
    })
}

async fn run_git(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<String, WorkflowError> {
    run_git_inner(repository_path, arguments, false)
        .await?
        .ok_or(WorkflowError::GitFailed)
        .and_then(|bytes| String::from_utf8(bytes).map_err(|_| WorkflowError::GitFailed))
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
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| WorkflowError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(WorkflowError::GitFailed)?;
    let read = tokio::spawn(async move {
        let mut output = Vec::new();
        stdout
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut output)
            .await
            .map(|_| output)
    });
    let status = match tokio::time::timeout(PREFLIGHT_DEADLINE, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) | Err(_) => {
            let _ = child.kill().await;
            return Err(WorkflowError::TimedOut);
        }
    };
    let output = read
        .await
        .map_err(|_| WorkflowError::GitFailed)?
        .map_err(|_| WorkflowError::GitFailed)?;
    if output.len() > 2 * 1024 * 1024 {
        return Err(WorkflowError::TooLarge);
    }
    if status.success() {
        Ok(Some(output))
    } else if allow_nonzero {
        Ok(None)
    } else {
        Err(WorkflowError::GitFailed)
    }
}
