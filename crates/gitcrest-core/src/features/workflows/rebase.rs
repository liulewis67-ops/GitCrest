use std::{collections::HashSet, path::Path};

use crate::{
    domain::error::WorkflowError,
    domain::workflow::{RebaseAction, RebaseTodoItem, WorkflowBackupNamespace, WorkflowOperation},
    ports::workflow_git::WorkflowGitPort,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

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

pub async fn read_backup_snapshot<G: WorkflowGitPort>(
    git: &G,
    repository_path: &Path,
) -> Result<RebaseBackupSnapshot, WorkflowError> {
    let head_oid = git.read_head_oid(repository_path).await?;
    let branch = git.read_current_branch(repository_path).await?;
    let state = git.read_worktree_state(repository_path).await?;
    let operation_in_progress = state.operation;
    let backups = list_backups(git, repository_path).await?;
    let can_rollback = head_oid.is_some()
        && branch.is_some()
        && state.dirty_paths.is_empty()
        && operation_in_progress.is_none()
        && !backups.is_empty();
    Ok(RebaseBackupSnapshot {
        head_oid,
        current_branch: branch,
        dirty_paths: state.dirty_paths,
        operation_in_progress,
        backups,
        can_rollback,
    })
}

pub async fn list_backups<G: WorkflowGitPort>(
    git: &G,
    repository_path: &Path,
) -> Result<Vec<RebaseBackup>, WorkflowError> {
    let mut backups = git
        .list_backup_references(repository_path, WorkflowBackupNamespace::Rebase)
        .await?
        .into_iter()
        .map(|backup| RebaseBackup {
            reference: backup.reference,
            oid: backup.oid,
            subject: backup.subject,
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.reference.cmp(&left.reference));
    Ok(backups)
}

pub async fn read_preview<G: WorkflowGitPort>(
    git: &G,
    repo_id: String,
    repository_path: &Path,
    onto: &str,
) -> Result<RebasePreview, WorkflowError> {
    if !(4..=64).contains(&onto.len()) || !onto.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorkflowError::InvalidTarget);
    }
    let onto_oid = git.resolve_commit_target(repository_path, onto).await?;
    let head_oid = git.read_head_oid(repository_path).await?;
    let current_branch = git.read_current_branch(repository_path).await?;

    let commit_list = if let Some(head_oid) = &head_oid {
        git.list_rebase_commits(repository_path, &onto_oid, head_oid)
            .await?
    } else {
        crate::domain::workflow::WorkflowRebaseCommitList {
            commits: Vec::new(),
            omitted_commit_count: 0,
            published_commit_oids: Vec::new(),
        }
    };
    let commits = commit_list
        .commits
        .into_iter()
        .map(|commit| RebaseCommit {
            oid: commit.oid,
            subject: commit.subject,
        })
        .collect::<Vec<_>>();
    let omitted_commit_count = commit_list.omitted_commit_count;
    let state = git.read_worktree_state(repository_path).await?;
    let operation_in_progress = state.operation;
    let published_commit_oids = commit_list.published_commit_oids;
    let can_start = head_oid.is_some()
        && current_branch.is_some()
        && onto_oid != head_oid.as_deref().unwrap_or_default()
        && !commits.is_empty()
        && omitted_commit_count == 0
        && state.dirty_paths.is_empty()
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
    for path in &state.dirty_paths {
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
        dirty_paths: state.dirty_paths,
        omitted_dirty_path_count: state.omitted_dirty_path_count,
        operation_in_progress,
        preview_revision: format!("sha256:{:x}", digest.finalize()),
        can_start,
    })
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
