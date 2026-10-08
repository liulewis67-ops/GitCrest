use std::{collections::HashSet, path::Path, process::Stdio, time::Duration};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
};

use crate::{
    domain::error::WorkflowError,
    domain::workflow::{RebaseAction, RebaseTodoItem, WorkflowOperation},
    workflows::read_worktree_state,
};

const MAX_COMMITS: usize = 200;
const PREFLIGHT_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub oid: String,
    pub subject: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RebaseTodoError {
    StaleCommit,
    EmptySequence,
    InvalidActionOrder,
    DropConfirmationRequired,
    PublishedConfirmationRequired,
    MessageRequired,
    UnexpectedMessage,
}

pub fn validate_todo(
    preview: &RebasePreview,
    todo: &[RebaseTodoItem],
    confirm_drop: bool,
    confirm_published_rewrite: bool,
) -> Result<(), RebaseTodoError> {
    let expected = preview
        .commits
        .iter()
        .map(|commit| commit.oid.as_str())
        .collect::<HashSet<_>>();
    let submitted = todo
        .iter()
        .map(|item| item.oid.as_str())
        .collect::<HashSet<_>>();
    if todo.len() != preview.commits.len() || submitted.len() != todo.len() || submitted != expected
    {
        return Err(RebaseTodoError::StaleCommit);
    }
    if todo.iter().all(|item| item.action == RebaseAction::Drop) {
        return Err(RebaseTodoError::EmptySequence);
    }
    if todo.iter().any(|item| item.action == RebaseAction::Drop) && !confirm_drop {
        return Err(RebaseTodoError::DropConfirmationRequired);
    }
    if !preview.published_commit_oids.is_empty() && !confirm_published_rewrite {
        return Err(RebaseTodoError::PublishedConfirmationRequired);
    }
    let mut has_previous_commit = false;
    for item in todo {
        if matches!(item.action, RebaseAction::Squash | RebaseAction::Fixup) && !has_previous_commit
        {
            return Err(RebaseTodoError::InvalidActionOrder);
        }
        if item.action != RebaseAction::Drop {
            has_previous_commit = true;
        }
        match (item.action, item.message.as_deref()) {
            (RebaseAction::Reword, Some(message))
                if !message.trim().is_empty()
                    && message.len() <= 4096
                    && !message.contains('\0') => {}
            (RebaseAction::Reword, _) => return Err(RebaseTodoError::MessageRequired),
            (_, Some(_)) => return Err(RebaseTodoError::UnexpectedMessage),
            (_, None) => {}
        }
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct RebasePreview {
    pub repo_id: String,
    pub head_oid: Option<String>,
    pub onto_oid: String,
    pub current_branch: Option<String>,
    pub commits: Vec<RebaseCommit>,
    pub omitted_commit_count: u32,
    pub published_commit_oids: Vec<String>,
    pub dirty_paths: Vec<String>,
    pub omitted_dirty_path_count: u32,
    pub operation_in_progress: Option<WorkflowOperation>,
    pub preview_revision: String,
    pub can_start: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseBackup {
    pub reference: String,
    pub oid: String,
    pub subject: String,
}

#[derive(Clone, Debug)]
pub struct RebaseBackupSnapshot {
    pub head_oid: Option<String>,
    pub current_branch: Option<String>,
    pub dirty_paths: Vec<String>,
    pub operation_in_progress: Option<WorkflowOperation>,
    pub backups: Vec<RebaseBackup>,
    pub can_rollback: bool,
}

pub async fn read_backup_snapshot(
    repository_path: &Path,
) -> Result<RebaseBackupSnapshot, WorkflowError> {
    let head_oid = run_git_optional(
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "HEAD^{commit}".into(),
        ],
    )
    .await?
    .map(|value| String::from_utf8_lossy(&value).trim().to_owned());
    let branch = run_git_optional(
        repository_path,
        &[
            "symbolic-ref".into(),
            "--quiet".into(),
            "--short".into(),
            "HEAD".into(),
        ],
    )
    .await?
    .map(|value| String::from_utf8_lossy(&value).trim().to_owned());
    let (dirty_paths, _, _, _, operation_in_progress) =
        read_worktree_state(repository_path).await?;
    let backups = list_backups(repository_path).await?;
    let can_rollback = head_oid.is_some()
        && branch.is_some()
        && dirty_paths.is_empty()
        && operation_in_progress.is_none()
        && !backups.is_empty();
    Ok(RebaseBackupSnapshot {
        head_oid,
        current_branch: branch,
        dirty_paths,
        operation_in_progress,
        backups,
        can_rollback,
    })
}

pub async fn list_backups(repository_path: &Path) -> Result<Vec<RebaseBackup>, WorkflowError> {
    let output = run_git(
        repository_path,
        &[
            "for-each-ref".into(),
            "--format=%(refname)%00%(objectname)%00%(subject)".into(),
            "refs/gitcrest/rebase-backups".into(),
        ],
    )
    .await?;
    let mut backups = output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\0');
            Some(RebaseBackup {
                reference: fields.next()?.to_owned(),
                oid: fields.next()?.to_owned(),
                subject: fields.next()?.to_owned(),
            })
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.reference.cmp(&left.reference));
    Ok(backups)
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
    let mut published_commit_oids = Vec::new();
    let mut published_checks = JoinSet::new();
    let semaphore = std::sync::Arc::new(Semaphore::new(8));
    for commit in &commits {
        let oid = commit.oid.clone();
        let path = repository_path.to_path_buf();
        let permits = semaphore.clone();
        published_checks.spawn(async move {
            let permit: OwnedSemaphorePermit = permits
                .acquire_owned()
                .await
                .map_err(|_| WorkflowError::GitFailed)?;
            let result = run_git(
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
            result.map(|refs| (oid, !refs.trim().is_empty()))
        });
    }
    while let Some(result) = published_checks.join_next().await {
        let (oid, is_published) = result.map_err(|_| WorkflowError::GitFailed)??;
        if is_published {
            published_commit_oids.push(oid);
        }
    }
    published_commit_oids.sort();
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
    for oid in &published_commit_oids {
        digest.update(oid.as_bytes());
        digest.update([0]);
    }
    Ok(RebasePreview {
        repo_id,
        head_oid,
        onto_oid,
        current_branch,
        commits,
        omitted_commit_count,
        published_commit_oids,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn preview() -> RebasePreview {
        RebasePreview {
            repo_id: "repo_fixture".into(),
            head_oid: Some("a".repeat(40)),
            onto_oid: "b".repeat(40),
            current_branch: Some("feature".into()),
            commits: ["first", "second", "third"]
                .into_iter()
                .enumerate()
                .map(|(index, subject)| RebaseCommit {
                    oid: format!("{}{}", "c".repeat(39), index + 1),
                    subject: subject.into(),
                })
                .collect(),
            omitted_commit_count: 0,
            published_commit_oids: Vec::new(),
            dirty_paths: Vec::new(),
            omitted_dirty_path_count: 0,
            operation_in_progress: None,
            preview_revision: format!("sha256:{}", "d".repeat(64)),
            can_start: true,
        }
    }

    #[test]
    fn rebase_todo_validates_exact_commits_drop_confirmation_and_action_order() {
        let preview = preview();
        let todo = vec![
            RebaseTodoItem {
                oid: preview.commits[0].oid.clone(),
                action: RebaseAction::Pick,
                message: None,
            },
            RebaseTodoItem {
                oid: preview.commits[1].oid.clone(),
                action: RebaseAction::Fixup,
                message: None,
            },
            RebaseTodoItem {
                oid: preview.commits[2].oid.clone(),
                action: RebaseAction::Reword,
                message: Some("replacement subject\n\nBody".into()),
            },
        ];
        assert_eq!(validate_todo(&preview, &todo, false, false), Ok(()));

        let mut dropped = todo.clone();
        dropped[2].action = RebaseAction::Drop;
        dropped[2].message = None;
        assert_eq!(
            validate_todo(&preview, &dropped, false, false),
            Err(RebaseTodoError::DropConfirmationRequired)
        );
        assert_eq!(validate_todo(&preview, &dropped, true, false), Ok(()));

        let mut published = preview.clone();
        published
            .published_commit_oids
            .push(preview.commits[0].oid.clone());
        assert_eq!(
            validate_todo(&published, &todo, false, false),
            Err(RebaseTodoError::PublishedConfirmationRequired)
        );
        assert_eq!(validate_todo(&published, &todo, false, true), Ok(()));

        let mut invalid_order = todo.clone();
        invalid_order.swap(0, 1);
        assert_eq!(
            validate_todo(&preview, &invalid_order, false, false),
            Err(RebaseTodoError::InvalidActionOrder)
        );
        let incomplete = &todo[..2];
        assert_eq!(
            validate_todo(&preview, incomplete, false, false),
            Err(RebaseTodoError::StaleCommit)
        );
    }
}
