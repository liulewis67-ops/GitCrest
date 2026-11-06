use super::*;
use crate::{
    domain::{operation::*, shelf::ShelfSnapshot},
    git::command::GitCommandService,
    ports::{operations::OperationStorePort, shelves::ShelfStorePort},
    storage::{diff::DiffWorktreeAdapter, RepositoryStore},
};
use std::{process::Command, sync::Arc};

fn git(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
pub(crate) fn repository() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path();
    git(path, &["init", "-q", "-b", "main"]);
    git(path, &["config", "user.name", "Snapshot Test"]);
    git(path, &["config", "user.email", "snapshot@example.invalid"]);
    git(path, &["config", "core.autocrlf", "false"]);
    std::fs::write(path.join("a"), "base a\n").unwrap();
    std::fs::write(path.join("b"), "base b\n").unwrap();
    git(path, &["add", "."]);
    git(path, &["commit", "-qm", "base"]);
    std::fs::write(path.join("a"), "staged a\n").unwrap();
    git(path, &["add", "a"]);
    std::fs::write(path.join("a"), "working a\n").unwrap();
    std::fs::write(path.join("b"), "working b\n").unwrap();
    std::fs::write(path.join("untracked"), "new file\n").unwrap();
    directory
}
fn shelf(before: &PreservationSnapshot, scope: DiffScope, patch: Vec<u8>) -> ShelfRecord {
    ShelfRecord {
        snapshot: ShelfSnapshot {
            shelf_id: "backup".into(),
            repo_id: "repo".into(),
            name: "backup".into(),
            description: String::new(),
            paths: vec!["a".into()],
            scope: Some(scope),
            head_oid: before.head.clone(),
            created_at_ms: 1,
        },
        patch,
    }
}
async fn snapshot(path: &Path) -> PreservationSnapshot {
    read_snapshot(
        &GitCommandService::default(),
        &DiffWorktreeAdapter,
        "repo",
        path,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn shelf_worktree_cleanup_evidence_preserves_index_and_detects_other_edits_or_branch_changes()
{
    let directory = repository();
    let path = directory.path();
    let before = snapshot(path).await;
    let saved = shelf(&before, DiffScope::WorkingTree, vec![]);
    git(path, &["restore", "--worktree", "--", "a"]);
    let after = snapshot(path).await;
    assert!(before.confirms_cleanup(&after, &saved));
    assert_ne!(before.fingerprint(), after.fingerprint());
    std::fs::write(path.join("b"), "external change\n").unwrap();
    assert!(!before.confirms_cleanup(&snapshot(path).await, &saved));
    std::fs::write(path.join("b"), "working b\n").unwrap();
    git(path, &["add", "b"]);
    assert!(!before.confirms_cleanup(&snapshot(path).await, &saved));
    git(path, &["reset", "-q", "--", "b"]);
    git(path, &["switch", "--detach", "-q"]);
    assert!(!before.confirms_cleanup(&snapshot(path).await, &saved));
}

#[tokio::test]
async fn shelf_clean_journal_is_verified_only_after_real_index_and_worktree_cleanup() {
    let directory = repository();
    let path = directory.path();
    let before = snapshot(path).await;
    let commands = GitCommandService::default();
    let status = commands
        .read_status("repo".into(), path, &[])
        .await
        .unwrap();
    let file = status.files.iter().find(|file| file.path == "a").unwrap();
    let patch = diff::read_with_patch(
        &commands,
        &DiffWorktreeAdapter,
        "repo".into(),
        path,
        file,
        DiffScope::Index,
    )
    .await
    .unwrap()
    .patch;
    let saved = shelf(&before, DiffScope::Index, patch);
    let store = Arc::new(RepositoryStore::default());
    store.insert_test_repository_at("repo", path);
    let operation = store
        .create_operation(NewOperation {
            operation_id: "op".into(),
            repo_id: "repo".into(),
            resource_key: path.join(".git").to_string_lossy().into_owned(),
            request_id: "request".into(),
            request: OperationRequest {
                command: OperationCommand::Checkout {
                    target: "main".into(),
                    target_oid: before.head.clone().unwrap(),
                },
                source_head_oid: before.head.clone(),
                source_branch: before.branch.clone(),
                changes_fingerprint: before.fingerprint(),
                preservation: PreservationPolicy::Restore,
            },
        })
        .unwrap();
    let mut journal = super::super::journal::ShelfSaveJournal::for_group(
        store.clone(),
        operation,
        &before,
        &saved,
        0,
        0,
    )
    .unwrap();
    journal.before_save(&saved).await.unwrap();
    store.save_shelf_record(saved.clone()).unwrap();
    journal.before_cleanup(&saved).await.unwrap();
    assert!(journal
        .confirm_cleanup(&before, &before, &saved)
        .await
        .is_err());
    assert_eq!(
        store.operation("op").unwrap().unwrap().steps[1].status,
        OperationStepStatus::IntentRecorded
    );
    git(path, &["restore", "--staged", "--worktree", "--", "a"]);
    git(
        path,
        &["commit", "--allow-empty", "-qm", "external head movement"],
    );
    assert!(journal
        .confirm_cleanup(&before, &snapshot(path).await, &saved)
        .await
        .is_err());
    git(path, &["reset", "--soft", before.head.as_deref().unwrap()]);
    let after = snapshot(path).await;
    let mut changed_backup = saved.clone();
    changed_backup.patch.push(b'x');
    assert!(journal
        .confirm_cleanup(&before, &after, &changed_backup)
        .await
        .is_err());
    journal
        .confirm_cleanup(&before, &after, &saved)
        .await
        .unwrap();
    let current = store.operation("op").unwrap().unwrap();
    assert_eq!(current.steps[1].status, OperationStepStatus::Verified);
    assert_eq!(
        current.steps[1].after_fingerprint,
        Some(after.fingerprint())
    );
    assert_eq!(current.state.phase, OperationPhase::Saving);
    assert_eq!(current.backups[0].disposition, BackupDisposition::Retained);
    assert!(store
        .operation_owner(&current.resource_key)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn shelf_snapshot_refuses_binary_changes_instead_of_trusting_a_binary_diff_label() {
    let directory = repository();
    std::fs::write(directory.path().join("binary"), b"binary\0content").unwrap();
    assert_eq!(
        read_snapshot(
            &GitCommandService::default(),
            &DiffWorktreeAdapter,
            "repo",
            directory.path()
        )
        .await,
        Err(EvidenceError::Unsupported)
    );
}

#[tokio::test]
async fn shelf_cleanup_reconciliation_uses_persisted_expectation_after_database_reopen_without_replay(
) {
    let directory = repository();
    let path = directory.path();
    let before = snapshot(path).await;
    let commands = GitCommandService::default();
    let status = commands
        .read_status("repo".into(), path, &[])
        .await
        .unwrap();
    let file = status.files.iter().find(|file| file.path == "a").unwrap();
    let patch = diff::read_with_patch(
        &commands,
        &DiffWorktreeAdapter,
        "repo".into(),
        path,
        file,
        DiffScope::WorkingTree,
    )
    .await
    .unwrap()
    .patch;
    let saved = shelf(&before, DiffScope::WorkingTree, patch);
    let data = tempfile::tempdir().unwrap();
    let database = data.path().join("operations.sqlite");
    let store = Arc::new(RepositoryStore::open(&database).unwrap());
    store.insert_test_repository_at("repo", path);
    let operation = store
        .create_operation(NewOperation {
            operation_id: "op".into(),
            repo_id: "repo".into(),
            resource_key: path.join(".git").to_string_lossy().into_owned(),
            request_id: "request".into(),
            request: OperationRequest {
                command: OperationCommand::Checkout {
                    target: "main".into(),
                    target_oid: before.head.clone().unwrap(),
                },
                source_head_oid: before.head.clone(),
                source_branch: before.branch.clone(),
                changes_fingerprint: before.fingerprint(),
                preservation: PreservationPolicy::Restore,
            },
        })
        .unwrap();
    let mut journal = super::super::journal::ShelfSaveJournal::for_group(
        store.clone(),
        operation,
        &before,
        &saved,
        0,
        0,
    )
    .unwrap();
    journal.before_save(&saved).await.unwrap();
    store.save_shelf_record(saved.clone()).unwrap();
    journal.before_cleanup(&saved).await.unwrap();
    git(path, &["restore", "--worktree", "--", "a"]);
    // Lose all in-memory pre-clean evidence before reading the journal again.
    drop(journal);
    drop(store);
    drop(before);
    drop(saved);
    let reopened = Arc::new(RepositoryStore::open(&database).unwrap());
    let operation = reopened.operation("op").unwrap().unwrap();
    let mut clean = operation.steps.last().unwrap().clone();
    clean.status = OperationStepStatus::Unknown;
    let mut state = operation.state.clone();
    state.status = OperationStatus::RecoveryRequired;
    state.wait_reason = Some(OperationWaitReason::OutcomeUnknown);
    let recovered = reopened
        .update_operation(
            "op",
            operation.version,
            OperationUpdate {
                state,
                step: Some(clean),
                backup: None,
            },
        )
        .unwrap();
    let shelf = reopened
        .read_shelf_record("repo", "backup")
        .unwrap()
        .unwrap();
    let mut recovery =
        super::super::journal::ShelfSaveJournal::for_recovery(reopened.clone(), recovered);
    std::fs::write(path.join("b"), "external edit\n").unwrap();
    assert!(recovery
        .reconcile_cleanup(&snapshot(path).await, &shelf)
        .await
        .is_err());
    assert_eq!(
        reopened.operation("op").unwrap().unwrap().steps[1].status,
        OperationStepStatus::Unknown
    );
    std::fs::write(path.join("b"), "working b\n").unwrap();
    let actual = snapshot(path).await;
    recovery.reconcile_cleanup(&actual, &shelf).await.unwrap();
    let verified = reopened.operation("op").unwrap().unwrap();
    assert_eq!(verified.steps[1].status, OperationStepStatus::Verified);
    assert_eq!(
        verified.steps[1].after_fingerprint,
        Some(actual.fingerprint())
    );
    assert_eq!(verified.state.status, OperationStatus::RecoveryRequired);
    assert_eq!(verified.backups[0].disposition, BackupDisposition::Retained);
    assert!(reopened
        .operation_owner(&verified.resource_key)
        .unwrap()
        .is_some());
    assert_eq!(snapshot(path).await, actual);
    assert!(recovery.reconcile_cleanup(&actual, &shelf).await.is_err());
    assert_eq!(
        reopened.operation("op").unwrap().unwrap().version,
        verified.version
    );
}
