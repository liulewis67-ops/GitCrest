use super::*;
use crate::{
    domain::task::TaskStatus,
    features::operations::{
        checkout::tests::fixture_with,
        restore::tests::{finished, ready, FailRestoreConfirmation},
    },
    ports::{operations::OperationStorePort, shelves::ShelfStorePort},
    storage::RepositoryStore,
};
use std::{process::Command, sync::Arc, time::Duration};

fn git(path: &Path, args: &[&str]) -> String {
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
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[tokio::test]
async fn capture_reconcile_reads_existing_tree_after_reopen_without_writing_or_applying() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let mut interrupted = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    interrupted.checkout.saves.operations = Arc::new(FailRestoreConfirmation(
        f.store.clone(),
        OperationStepKind::CaptureIndex,
    ));
    let task = interrupted.submit_next(&f.tasks, &operation).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    let uncertain = f.store.operation("op").unwrap().unwrap();
    assert_eq!(uncertain.steps.len(), 6);
    assert_eq!(uncertain.steps[5].status, OperationStepStatus::Unknown);
    let reopened = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let mut recovery = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    recovery.checkout.saves.operations = reopened.clone();
    recovery.checkout.saves.shelves = reopened.clone();
    let path = f.repository.path();
    let reference = admission::index_reference("op", &uncertain.steps[5]);
    let expected_tree = git(path, &["rev-parse", "--verify", &reference]);
    let index_before = std::fs::read(path.join(".git/index")).unwrap();
    let refs_before = git(path, &["show-ref"]);
    let reconcile = recovery
        .submit_reconcile_capture(&f.tasks, &uncertain)
        .await
        .unwrap();
    let result = finished(&f.tasks, &reconcile.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
    let confirmed = reopened.operation("op").unwrap().unwrap();
    assert_eq!(confirmed.version, uncertain.version + 1);
    assert_eq!(confirmed.state, uncertain.state);
    assert_eq!(confirmed.backups, uncertain.backups);
    assert_eq!(confirmed.steps[5].status, OperationStepStatus::Verified);
    assert_eq!(
        confirmed.steps[5].after_fingerprint.as_deref(),
        Some(expected_tree.as_str())
    );
    assert_eq!(
        confirmed.steps[5].task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    assert_eq!(
        std::fs::read(path.join(".git/index")).unwrap(),
        index_before
    );
    assert_eq!(git(path, &["show-ref"]), refs_before);
    assert_eq!(std::fs::read_to_string(path.join("a")).unwrap(), "base\n");
    assert!(!path.join("new").exists());
    assert_eq!(reopened.list_shelf_snapshots("repo").unwrap().len(), 2);
    assert!(reopened
        .operation_owner(&confirmed.resource_key)
        .unwrap()
        .is_some());
    let repeated = recovery
        .submit_reconcile_capture(&f.tasks, &confirmed)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &repeated.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    let resume = recovery.submit_next(&f.tasks, &confirmed).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &resume.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(reopened.operation("op").unwrap().unwrap(), confirmed);
}

#[tokio::test]
async fn capture_reconcile_refuses_changed_state_or_missing_reference_without_recreating_it() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let operation = ready(&f).await;
    let mut interrupted = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    interrupted.checkout.saves.operations = Arc::new(FailRestoreConfirmation(
        f.store.clone(),
        OperationStepKind::CaptureIndex,
    ));
    let task = interrupted.submit_next(&f.tasks, &operation).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    let uncertain = f.store.operation("op").unwrap().unwrap();
    let recovery = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let path = f.repository.path();
    std::fs::write(path.join("a"), "external\n").unwrap();
    git(path, &["add", "a"]);
    let check = recovery
        .submit_reconcile_capture(&f.tasks, &uncertain)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &check.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(f.store.operation("op").unwrap().unwrap(), uncertain);
    assert_eq!(git(path, &["show", ":a"]), "external");
    git(
        path,
        &[
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            "a",
        ],
    );
    let reference = admission::index_reference("op", &uncertain.steps[5]);
    git(path, &["update-ref", "-d", &reference]);
    let refs_before = git(path, &["show-ref"]);
    let check = recovery
        .submit_reconcile_capture(&f.tasks, &uncertain)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &check.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(f.store.operation("op").unwrap().unwrap(), uncertain);
    assert_eq!(git(path, &["show-ref"]), refs_before);
}

#[tokio::test]
async fn capture_reconcile_refuses_ordinary_task_context_without_mutation() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let service = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let task = f
        .tasks
        .submit(
            None,
            None,
            "unrelated",
            "invalidCaptureReconcile",
            move |context| async move {
                service
                    .reconcile_capture("op", &context)
                    .await
                    .map(|_| None)
            },
        )
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(f.store.operation("op").unwrap().unwrap(), f.operation);
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "working\n"
    );
}
