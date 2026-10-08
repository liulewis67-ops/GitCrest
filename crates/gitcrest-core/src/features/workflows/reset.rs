use std::{path::Path, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

use crate::workflows::{read_worktree_state, WorkflowError, WorkflowOperation};

const MAX_RESET_PATHS: usize = 200;
const MAX_GIT_OUTPUT: usize = 2 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

impl ResetMode {
    pub fn git_argument(self) -> &'static str {
        match self {
            Self::Soft => "--soft",
            Self::Mixed => "--mixed",
            Self::Hard => "--hard",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPreview {
    pub repo_id: String,
    pub expected_head_oid: String,
    pub target_oid: String,
    pub current_branch: String,
    pub mode: ResetMode,
    pub commits_removed: u32,
    pub commits_added: u32,
    pub affected_paths: Vec<String>,
    pub omitted_path_count: u32,
    pub dirty_paths: Vec<String>,
    pub operation_in_progress: Option<WorkflowOperation>,
    pub preview_revision: String,
    pub can_start: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetBackup {
    pub reference: String,
    pub oid: String,
    pub subject: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetBackupSnapshot {
    pub head_oid: Option<String>,
    pub current_branch: Option<String>,
    pub dirty_paths: Vec<String>,
    pub operation_in_progress: Option<WorkflowOperation>,
    pub backups: Vec<ResetBackup>,
    pub can_restore: bool,
}

pub async fn read_backup_snapshot(
    repository_path: &Path,
) -> Result<ResetBackupSnapshot, WorkflowError> {
    let head_oid = match git(repository_path, &["rev-parse", "--verify", "HEAD^{commit}"]).await {
        Ok(value) => Some(value),
        Err(WorkflowError::GitFailed) => None,
        Err(error) => return Err(error),
    };
    let current_branch = match git(
        repository_path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .await
    {
        Ok(value) => Some(value),
        Err(WorkflowError::GitFailed) => None,
        Err(error) => return Err(error),
    };
    let (dirty_paths, _, _, _, operation_in_progress) =
        read_worktree_state(repository_path).await?;
    let backup_output = git(
        repository_path,
        &[
            "for-each-ref",
            "--count=1000",
            "--format=%(refname)%00%(objectname)%00%(subject)",
            "refs/gitcrest/reset-backups",
        ],
    )
    .await?;
    let mut backups = backup_output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\0');
            Some(ResetBackup {
                reference: fields.next()?.to_owned(),
                oid: fields.next()?.to_owned(),
                subject: fields.next()?.to_owned(),
            })
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.reference.cmp(&left.reference));
    let can_restore = head_oid.is_some()
        && current_branch.is_some()
        && dirty_paths.is_empty()
        && operation_in_progress.is_none()
        && !backups.is_empty();
    Ok(ResetBackupSnapshot {
        head_oid,
        current_branch,
        dirty_paths,
        operation_in_progress,
        backups,
        can_restore,
    })
}

pub async fn read_preview(
    repo_id: String,
    repository_path: &Path,
    target: &str,
    mode: ResetMode,
) -> Result<ResetPreview, WorkflowError> {
    if !(4..=64).contains(&target.len()) || !target.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorkflowError::InvalidTarget);
    }
    let target_oid = git(
        repository_path,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{target}^{{commit}}"),
        ],
    )
    .await?;
    let expected_head_oid =
        git(repository_path, &["rev-parse", "--verify", "HEAD^{commit}"]).await?;
    let current_branch = git(
        repository_path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .await?;
    let counts = git(
        repository_path,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{expected_head_oid}...{target_oid}"),
        ],
    )
    .await?;
    let (commits_removed, commits_added) = counts
        .split_once('\t')
        .and_then(|(left, right)| Some((left.parse().ok()?, right.parse().ok()?)))
        .ok_or(WorkflowError::GitFailed)?;
    let (dirty_paths, _, _, _, operation_in_progress) =
        read_worktree_state(repository_path).await?;
    let path_output = git(
        repository_path,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            &format!("{expected_head_oid}..{target_oid}"),
            "--",
        ],
    )
    .await?;
    let mut affected_paths = path_output
        .lines()
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    affected_paths.sort();
    affected_paths.dedup();
    let omitted_path_count = affected_paths.len().saturating_sub(MAX_RESET_PATHS) as u32;
    affected_paths.truncate(MAX_RESET_PATHS);
    let can_start = expected_head_oid != target_oid
        && operation_in_progress.is_none()
        && (mode != ResetMode::Hard || dirty_paths.is_empty());
    let mut digest = Sha256::new();
    digest.update(repo_id.as_bytes());
    digest.update([0]);
    digest.update(expected_head_oid.as_bytes());
    digest.update([0]);
    digest.update(target_oid.as_bytes());
    digest.update([0]);
    digest.update(current_branch.as_bytes());
    digest.update([0]);
    digest.update(mode.git_argument().as_bytes());
    digest.update([0]);
    digest.update(format!("{operation_in_progress:?}").as_bytes());
    digest.update([0]);
    for path in &affected_paths {
        digest.update(path.as_bytes());
        digest.update([0]);
    }
    for path in &dirty_paths {
        digest.update(path.as_bytes());
        digest.update([0]);
    }
    Ok(ResetPreview {
        repo_id,
        expected_head_oid,
        target_oid,
        current_branch,
        mode,
        commits_removed,
        commits_added,
        affected_paths,
        omitted_path_count,
        dirty_paths,
        operation_in_progress,
        preview_revision: format!("sha256:{:x}", digest.finalize()),
        can_start,
    })
}

async fn git(repository_path: &Path, arguments: &[&str]) -> Result<String, WorkflowError> {
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
            .take(MAX_GIT_OUTPUT as u64 + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| WorkflowError::GitFailed)?;
        if output.len() > MAX_GIT_OUTPUT {
            return Err(WorkflowError::TooLarge);
        }
        Ok(output)
    });
    let status = timeout(GIT_TIMEOUT, child.wait())
        .await
        .map_err(|_| WorkflowError::TimedOut)?
        .map_err(|_| WorkflowError::GitFailed)?;
    let output = read.await.map_err(|_| WorkflowError::GitFailed)??;
    if !status.success() {
        return Err(WorkflowError::GitFailed);
    }
    String::from_utf8(output)
        .map(|value| value.trim().to_owned())
        .map_err(|_| WorkflowError::GitFailed)
}
