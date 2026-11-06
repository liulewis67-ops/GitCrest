use super::*;
use crate::{
    domain::task::TaskStatus,
    features::operations::{
        checkout::tests::{fixture_with, Fixture},
        restore::tests::{finished, ready, FailRestoreConfirmation},
    },
    ports::{operations::OperationStorePort, shelves::ShelfStorePort},
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
async fn captured(f: &Fixture) -> GitOperation {
    let operation = ready(f).await;
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
    let unknown = f.store.operation("op").unwrap().unwrap();
    let recovery = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let check = recovery
        .submit_reconcile_capture(&f.tasks, &unknown)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &check.task_id).await.status,
        TaskStatus::Succeeded
    );
    f.store.operation("op").unwrap().unwrap()
}

#[tokio::test]
async fn capture_resume_reuses_verified_tree_then_restores_remaining_group_with_real_task_links() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let verified = captured(&f).await;
    let original_capture = verified.steps.last().unwrap().clone();
    let path = f.repository.path();
    let refs_before = git(path, &["show-ref"]);
    let service = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let resume = service
        .submit_resume_capture(&f.tasks, &verified)
        .await
        .unwrap();
    let result = finished(&f.tasks, &resume.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
    let indexed = f.store.operation("op").unwrap().unwrap();
    assert_eq!(indexed.steps.len(), 7);
    assert_eq!(indexed.steps[5], original_capture);
    assert_eq!(indexed.steps[6].kind, OperationStepKind::Restore);
    assert_eq!(
        indexed.steps[6].task_id.as_deref(),
        Some(resume.task_id.as_str())
    );
    assert_ne!(indexed.steps[5].task_id, indexed.steps[6].task_id);
    assert_eq!(indexed.steps[6].status, OperationStepStatus::Verified);
    assert_eq!(indexed.backups[0].disposition, BackupDisposition::Restored);
    assert_eq!(indexed.state.status, OperationStatus::Running);
    assert!(indexed.state.failure_code.is_none() && indexed.state.wait_reason.is_none());
    assert_eq!(git(path, &["show-ref"]), refs_before);
    assert_eq!(git(path, &["show", ":a"]), "staged");
    assert_eq!(std::fs::read_to_string(path.join("a")).unwrap(), "staged\n");
    assert!(matches!(
        service.submit_resume_capture(&f.tasks, &verified).await,
        Err(TaskSubmitError::StaleOperation)
    ));
    let repeated = service
        .submit_resume_capture(&f.tasks, &indexed)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &repeated.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(f.store.operation("op").unwrap().unwrap(), indexed);
    let next = service.submit_next(&f.tasks, &indexed).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &next.task_id).await.status,
        TaskStatus::Succeeded
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let done = f.store.operation("op").unwrap().unwrap();
    assert_eq!(done.state.status, OperationStatus::Succeeded);
    assert_eq!(done.steps.len(), 9);
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "working\n"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("new")).unwrap(),
        "untracked\n"
    );
    assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
    assert!(f
        .store
        .operation_owner(&done.resource_key)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn capture_resume_refuses_external_edits_before_changing_recovery_state() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let verified = captured(&f).await;
    std::fs::write(f.repository.path().join("b"), "external b\n").unwrap();
    let service = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let resume = service
        .submit_resume_capture(&f.tasks, &verified)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &resume.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(f.store.operation("op").unwrap().unwrap(), verified);
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("b")).unwrap(),
        "external b\n"
    );
    assert!(!f.repository.path().join("new").exists());
}

#[tokio::test]
async fn capture_resume_apply_confirmation_failure_keeps_unknown_group_and_original_capture() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let verified = captured(&f).await;
    let mut service = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    service.checkout.saves.operations = Arc::new(FailRestoreConfirmation(
        f.store.clone(),
        OperationStepKind::Restore,
    ));
    let resume = service
        .submit_resume_capture(&f.tasks, &verified)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &resume.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let unknown = f.store.operation("op").unwrap().unwrap();
    assert_eq!(unknown.state.status, OperationStatus::RecoveryRequired);
    assert_eq!(unknown.steps[5], verified.steps[5]);
    assert_eq!(unknown.steps[6].status, OperationStepStatus::Unknown);
    assert_eq!(
        unknown.steps[6].task_id.as_deref(),
        Some(resume.task_id.as_str())
    );
    assert_eq!(unknown.backups, verified.backups);
    assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
    assert!(!f.repository.path().join("new").exists());
    assert!(f
        .store
        .operation_owner(&unknown.resource_key)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn capture_resume_refuses_ordinary_context_without_mutation() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let service = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let task = f.tasks.submit(None, None, "unrelated", "invalidCaptureResume", move |context| async move {
        service.resume_capture("op", &context).await.map(|_| None)
    }).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(f.store.operation("op").unwrap().unwrap(), f.operation);
}
