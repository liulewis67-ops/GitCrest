use super::*;
use crate::{
    domain::{operation_action::*, request_access::RequestAccess, task::TaskStatus},
    features::operations::{
        actions::{ActionSubmitError, OperationActionService},
        checkout::tests::{fixture_with, Fixture},
        query::OperationQueryService,
        restore::tests::{finished, ready, FailRestoreConfirmation},
    },
    ports::{
        operations::{OperationStoreError, OperationStorePort},
        shelves::ShelfStorePort,
    },
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
async fn observed(f: &Fixture, working: bool) -> GitOperation {
    let mut operation = ready(f).await;
    let mut service = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    if working {
        let first = service.submit_next(&f.tasks, &operation).await.unwrap();
        assert_eq!(
            finished(&f.tasks, &first.task_id).await.status,
            TaskStatus::Succeeded
        );
        operation = f.store.operation("op").unwrap().unwrap();
    }
    service.checkout.saves.operations = Arc::new(FailRestoreConfirmation(
        f.store.clone(),
        OperationStepKind::Restore,
    ));
    let task = service.submit_next(&f.tasks, &operation).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert!(stopped.steps.last().unwrap().after_fingerprint.is_some());
    stopped
}

#[tokio::test]
async fn restore_reconcile_confirms_both_scopes_after_reopen_with_action_deduplication_and_no_git_writes(
) {
    for working in [false, true] {
        let f = fixture_with(working, false, PreservationPolicy::Restore, false).await;
        let stopped = observed(&f, working).await;
        let original = stopped.steps.last().unwrap().clone();
        let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
        let mut recovery = OperationRestoreService {
            checkout: f.checkout.clone(),
        };
        recovery.checkout.saves.operations = store.clone();
        recovery.checkout.saves.shelves = store.clone();
        let service = OperationActionService {
            store: store.clone(),
            restore: recovery.clone(),
        };
        let query = OperationQueryService {
            store: store.clone(),
        };
        assert_eq!(
            query
                .get(RequestAccess::ReadWrite, "repo", "op")
                .await
                .unwrap()
                .allowed_actions,
            vec![OperationActionKind::ReconcileRestore]
        );
        let request = OperationActionRequest {
            request_id: "verify-restored".into(),
            expected_version: stopped.version,
            kind: OperationActionKind::ReconcileRestore,
        };
        for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
            assert!(matches!(
                service
                    .submit(&f.tasks, access, "repo", "op", request.clone())
                    .await,
                Err(ActionSubmitError::Forbidden)
            ));
        }
        assert!(matches!(
            service
                .submit(
                    &f.tasks,
                    RequestAccess::ReadWrite,
                    "other",
                    "op",
                    request.clone()
                )
                .await,
            Err(ActionSubmitError::Store(OperationStoreError::NotFound))
        ));
        assert_eq!(store.operation("op").unwrap().unwrap(), stopped);
        let path = f.repository.path();
        let index = std::fs::read(path.join(".git/index")).unwrap();
        let refs = git(path, &["show-ref"]);
        let contents = std::fs::read(path.join("a")).unwrap();
        let submission = service
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request.clone(),
            )
            .await
            .unwrap();
        let task = submission.task.unwrap();
        let result = finished(&f.tasks, &task.task_id).await;
        assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
        let confirmed = store.operation("op").unwrap().unwrap();
        assert_eq!(confirmed.steps.len(), stopped.steps.len());
        let last = confirmed.steps.last().unwrap();
        assert_eq!(last.status, OperationStepStatus::Verified);
        assert_eq!(last.task_id, original.task_id);
        assert_ne!(last.task_id.as_deref(), Some(task.task_id.as_str()));
        assert_eq!(last.after_fingerprint, original.after_fingerprint);
        assert!(last.failure_code.is_none());
        assert!(confirmed.state.failure_code.is_none() && confirmed.state.wait_reason.is_none());
        assert_eq!(
            confirmed.backups[usize::from(working)].disposition,
            BackupDisposition::Restored
        );
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        assert_eq!(git(path, &["show-ref"]), refs);
        assert_eq!(std::fs::read(path.join("a")).unwrap(), contents);
        assert_eq!(store.list_shelf_snapshots("repo").unwrap().len(), 2);
        let action = service
            .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", request)
            .await
            .unwrap()
            .action;
        assert_eq!(action.status, OperationActionStatus::Succeeded);
        assert_eq!(action.task_id.as_deref(), Some(task.task_id.as_str()));
        assert_eq!(store.operation("op").unwrap().unwrap(), confirmed);
        if working {
            assert_eq!(confirmed.state.status, OperationStatus::Succeeded);
            assert!(store
                .operation_owner(&confirmed.resource_key)
                .unwrap()
                .is_none());
        } else {
            assert_eq!(confirmed.state.status, OperationStatus::Running);
            assert!(store
                .operation_owner(&confirmed.resource_key)
                .unwrap()
                .is_some());
            assert_eq!(
                confirmed.backups[1].disposition,
                BackupDisposition::Retained
            );
            assert_eq!(std::fs::read_to_string(path.join("a")).unwrap(), "staged\n");
            let next = recovery.submit_next(&f.tasks, &confirmed).await.unwrap();
            assert_eq!(
                finished(&f.tasks, &next.task_id).await.status,
                TaskStatus::Succeeded
            );
            assert_eq!(
                std::fs::read_to_string(path.join("a")).unwrap(),
                "working\n"
            );
        }
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

async fn refuses(f: &Fixture, service: &OperationRestoreService, stopped: &GitOperation) {
    let path = f.repository.path();
    let index = std::fs::read(path.join(".git/index")).unwrap();
    let refs = git(path, &["show-ref"]);
    let contents = std::fs::read(path.join("a")).unwrap();
    let task = service
        .submit_reconcile_restore(&f.tasks, stopped)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::Failed
    );
    assert_eq!(f.store.operation("op").unwrap().unwrap(), *stopped);
    assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
    assert_eq!(git(path, &["show-ref"]), refs);
    assert_eq!(std::fs::read(path.join("a")).unwrap(), contents);
}

#[tokio::test]
async fn restore_reconcile_refuses_external_edits_wrong_branch_missing_roots_corrupt_backup_and_confirmation_failure(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let stopped = observed(&f, false).await;
    let path = f.repository.path();
    let service = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    std::fs::write(path.join("a"), "external\n").unwrap();
    refuses(&f, &service, &stopped).await;
    std::fs::write(path.join("a"), "staged\n").unwrap();
    git(path, &["switch", "--detach", "HEAD"]);
    refuses(&f, &service, &stopped).await;
    git(path, &["switch", "other"]);
    let capture = &stopped.steps[stopped.steps.len() - 2];
    let reference = admission::index_reference("op", capture);
    let tree = capture.after_fingerprint.as_ref().unwrap();
    git(path, &["update-ref", "-d", &reference]);
    refuses(&f, &service, &stopped).await;
    git(path, &["update-ref", &reference, tree]);
    // A commit which peels to the same tree is not the recorded tree root.
    let commit = git(path, &["commit-tree", tree, "-m", "foreign capture ref"]);
    git(path, &["update-ref", &reference, &commit]);
    refuses(&f, &service, &stopped).await;
    git(path, &["update-ref", &reference, tree]);
    let roots = stopped
        .steps
        .iter()
        .find_map(|s| s.source_objects.as_ref())
        .unwrap();
    git(path, &["update-ref", "-d", &roots.head_reference]);
    refuses(&f, &service, &stopped).await;
    git(
        path,
        &["update-ref", &roots.head_reference, &roots.head_oid],
    );
    let mut failing = service.clone();
    failing.checkout.saves.operations = Arc::new(FailRestoreConfirmation(
        f.store.clone(),
        OperationStepKind::Restore,
    ));
    refuses(&f, &failing, &stopped).await;
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
            rusqlite::params![b"corrupt".as_slice(), stopped.backups[0].shelf_id],
        )
        .unwrap();
    refuses(&f, &service, &stopped).await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn restore_reconcile_refuses_ordinary_task_context_without_mutation() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let stopped = observed(&f, false).await;
    let service = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    let task = f
        .tasks
        .submit(
            None,
            None,
            "unrelated",
            "misroutedRestoreReconcile",
            move |context| async move {
                service
                    .reconcile_restore("op", &context)
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
    assert_eq!(f.store.operation("op").unwrap().unwrap(), stopped);
    assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn local_read_policy_prevents_promisor_fetch_when_protected_objects_are_missing() {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let stopped = observed(&f, false).await;
    let path = f.repository.path();
    let remote = tempfile::tempdir().unwrap();
    git(
        path,
        &[
            "clone",
            "--bare",
            "--no-hardlinks",
            ".",
            remote.path().to_str().unwrap(),
        ],
    );
    let capture = &stopped.steps[stopped.steps.len() - 2];
    let tree = capture.after_fingerprint.as_ref().unwrap();
    let reference = admission::index_reference("op", capture);
    let marker = f._data.path().join("fetch-invoked");
    let script = f._data.path().join("record-upload-pack.sh");
    let quote = |value: &Path| {
        format!(
            "'{}'",
            value
                .to_string_lossy()
                .replace('\\', "/")
                .replace('\'', "'\\''")
        )
    };
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf 'fetch\\n' >> {}\nexec git upload-pack \"$@\"\n",
            quote(&marker)
        ),
    )
    .unwrap();
    git(
        path,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(
        path,
        &[
            "config",
            "remote.origin.uploadpack",
            &format!("sh {}", quote(&script)),
        ],
    );
    git(path, &["config", "remote.origin.promisor", "true"]);
    let object = path.join(".git/objects").join(&tree[..2]).join(&tree[2..]);
    assert!(object.is_file());
    std::fs::remove_file(&object).unwrap();
    let index = std::fs::read(path.join(".git/index")).unwrap();
    let head = std::fs::read(path.join(".git/HEAD")).unwrap();
    let ref_path = path.join(".git").join(&reference);
    let protected = std::fs::read(&ref_path).unwrap();
    assert!(f
        .saves
        .commands
        .verify_operation_index_root(path, &reference, tree)
        .await
        .is_err());
    let recovery = OperationRestoreService {
        checkout: f.checkout.clone(),
    };
    if let Ok(task) = recovery.submit_reconcile_restore(&f.tasks, &stopped).await {
        assert_eq!(
            finished(&f.tasks, &task.task_id).await.status,
            TaskStatus::Failed
        );
    }
    assert!(
        !marker.exists(),
        "read verification contacted the promisor remote"
    );
    assert!(!object.exists());
    assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
    assert_eq!(std::fs::read(path.join(".git/HEAD")).unwrap(), head);
    assert_eq!(std::fs::read(ref_path).unwrap(), protected);
    assert_eq!(f.store.operation("op").unwrap().unwrap(), stopped);
    // Prove this fixture can actually fetch the missing object. This control is
    // intentionally after the read-only assertions and allows lazy fetch.
    let control = Command::new("git")
        .arg("-C")
        .arg(path)
        .env("GIT_NO_LAZY_FETCH", "0")
        .args(["cat-file", "-t", tree])
        .output()
        .unwrap();
    assert!(
        control.status.success(),
        "{}",
        String::from_utf8_lossy(&control.stderr)
    );
    assert!(
        marker.exists(),
        "the control never exercised a real promisor fetch"
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
