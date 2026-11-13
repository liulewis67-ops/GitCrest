use super::*;
#[path = "failed_tests.rs"]
mod failed;
use crate::{
    domain::{
        operation_action::*,
        request_access::RequestAccess,
        task::{TaskSnapshot, TaskStatus},
    },
    execution::write_access::WriteAccess,
    features::operations::{
        actions::OperationActionService,
        checkout::tests::{fixture_with, preserve, Fixture},
        dto::OperationRecoveryResponse,
        query::OperationQueryService,
        restore::OperationRestoreService,
    },
    ports::{
        operation_actions::OperationActionStorePort,
        operation_queries::OperationQueryStorePort,
        operations::{OperationStoreError, OperationStorePort},
    },
    storage::RepositoryStore,
};
use std::{
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

fn git(path: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}

enum Mutation {
    Target,
    Source,
    MissingObject(String),
}
struct ChangeAfterIntent {
    store: Arc<RepositoryStore>,
    path: std::path::PathBuf,
    mutation: Mutation,
    fired: AtomicBool,
}
impl OperationStorePort for ChangeAfterIntent {
    fn update_operation(
        &self,
        id: &str,
        version: i64,
        update: OperationUpdate,
    ) -> Result<GitOperation, OperationStoreError> {
        let intent = update.step.as_ref().is_some_and(|s| {
            s.kind == OperationStepKind::Execute && s.status == OperationStepStatus::IntentRecorded
        });
        // Commit the real journal first. The independent writer changes Git
        // before the executor can run its post-intent review, in both modes.
        let operation = self.store.update_operation(id, version, update)?;
        if intent && !self.fired.swap(true, Ordering::SeqCst) {
            let path = &self.path;
            match &self.mutation {
                Mutation::Target => {
                    git(path, &["update-ref", "refs/heads/other", "HEAD"]);
                }
                Mutation::Source => {
                    std::fs::write(path.join("a"), "external after intent\n").unwrap()
                }
                Mutation::MissingObject(oid) => {
                    std::fs::remove_file(path.join(".git/objects").join(&oid[..2]).join(&oid[2..]))
                        .unwrap()
                }
            }
        }
        Ok(operation)
    }
    fn confirm_checkout_not_executed(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.store.confirm_checkout_not_executed(id, version, task)
    }
    fn operation(&self, id: &str) -> Result<Option<GitOperation>, OperationStoreError> {
        self.store.operation(id)
    }
    fn active_operations(&self) -> Result<Vec<GitOperation>, OperationStoreError> {
        self.store.active_operations()
    }
    fn operation_owner(&self, key: &str) -> Result<Option<String>, OperationStoreError> {
        self.store.operation_owner(key)
    }
    fn repository_operation_owner(
        &self,
        repo: &str,
    ) -> Result<Option<String>, OperationStoreError> {
        self.store.repository_operation_owner(repo)
    }
    fn operation_request(
        &self,
        repo: &str,
        id: &str,
    ) -> Result<Option<GitOperation>, OperationStoreError> {
        self.store.operation_request(repo, id)
    }
    fn create_operation(&self, value: NewOperation) -> Result<GitOperation, OperationStoreError> {
        self.store.create_operation(value)
    }
    fn record_preservation_plan(
        &self,
        id: &str,
        version: i64,
        plan: OperationPreservationPlan,
    ) -> Result<GitOperation, OperationStoreError> {
        self.store.record_preservation_plan(id, version, plan)
    }
    fn begin_source_recovery_after_rejection(
        &self,
        id: &str,
        version: i64,
        admitted: i64,
        task: &str,
        fp: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.store
            .begin_source_recovery_after_rejection(id, version, admitted, task, fp)
    }
    fn begin_source_recovery(
        &self,
        id: &str,
        version: i64,
        task: &str,
        fp: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.store.begin_source_recovery(id, version, task, fp)
    }
    fn activate_restoration_resume(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.store.activate_restoration_resume(id, version, task)
    }
    fn take_over_planned_restoration(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.store.take_over_planned_restoration(id, version, task)
    }
    fn take_over_planned_checkout(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, OperationStoreError> {
        self.store.take_over_planned_checkout(id, version, task)
    }
    fn preservation_actor_authorized(
        &self,
        id: &str,
        task: &str,
        seq: u32,
    ) -> Result<bool, OperationStoreError> {
        self.store.preservation_actor_authorized(id, task, seq)
    }
}
fn actions(f: &Fixture, mutation: Mutation) -> OperationActionService {
    let mut checkout = f.checkout.clone();
    checkout.saves.operations = Arc::new(ChangeAfterIntent {
        store: f.store.clone(),
        path: f.repository.path().to_owned(),
        mutation,
        fired: AtomicBool::new(false),
    });
    OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService { checkout },
    }
}
fn request(id: &str, version: i64, kind: OperationActionKind) -> OperationActionRequest {
    OperationActionRequest {
        request_id: id.into(),
        expected_version: version,
        kind,
    }
}
async fn finished(tasks: &TaskService, id: &str) -> TaskSnapshot {
    tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            let t = tasks.get(id).await.unwrap();
            if t.status.is_terminal() {
                return t;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("not-executed task {id} exceeded its bounded wait"))
}
async fn submit(
    tasks: &TaskService,
    service: &OperationActionService,
    store: &RepositoryStore,
    id: &str,
    kind: OperationActionKind,
) -> TaskSnapshot {
    let op = store.operation("op").unwrap().unwrap();
    let submitted = service
        .submit(
            tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(id, op.version, kind),
        )
        .await
        .unwrap();
    finished(tasks, &submitted.task.unwrap().task_id).await
}
fn assert_source(f: &Fixture, operation: &GitOperation) {
    assert_eq!(
        git(f.repository.path(), &["rev-parse", "HEAD"]),
        operation.request.source_head_oid.clone().unwrap()
    );
    assert_eq!(
        git(f.repository.path(), &["branch", "--show-current"]),
        "main"
    );
    assert_eq!(git(f.repository.path(), &["show", ":a"]), "staged");
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "working\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("b")).unwrap(),
        "local b\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("new")).unwrap(),
        "untracked\n"
    );
    assert_eq!(operation.state.status, OperationStatus::Failed);
    assert_eq!(
        operation.state.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert!(operation
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Restored));
    assert!(f
        .store
        .operation_owner(&operation.resource_key)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn not_executed_checkout_recovers_both_modes_and_policies_in_the_original_running_action() {
    for case in 0..4 {
        let detached = case % 2 == 1;
        let policy = if case >= 2 {
            PreservationPolicy::KeepOnSourceBranch
        } else {
            PreservationPolicy::Restore
        };
        let f = fixture_with(detached, false, policy, false).await;
        let saved = preserve(&f).await;
        let kind = if case >= 2 {
            let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
            db.execute_batch("CREATE TRIGGER stop_intent BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='execute' AND json_extract(NEW.step_json,'$.status')='intentRecorded' BEGIN SELECT RAISE(ABORT,'planned boundary'); END;").unwrap();
            let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
            assert_eq!(
                finished(&f.tasks, &task.task_id).await.failure_code,
                Some(GitFailureCode::OutcomeUnknown)
            );
            db.execute_batch("DROP TRIGGER stop_intent").unwrap();
            OperationActionKind::ResumePlannedCheckout
        } else {
            OperationActionKind::CompletePreparedCheckout
        };
        let (mutation, object) =
            if let OperationCommand::CheckoutDetached { target_oid } = &saved.request.command {
                let path = f
                    .repository
                    .path()
                    .join(".git/objects")
                    .join(&target_oid[..2])
                    .join(&target_oid[2..]);
                (
                    Mutation::MissingObject(target_oid.clone()),
                    Some((path.clone(), std::fs::read(path).unwrap())),
                )
            } else {
                (Mutation::Target, None)
            };
        let service = actions(&f, mutation);
        let result = submit(&f.tasks, &service, &f.store, "original", kind).await;
        assert_eq!(
            result.failure_code,
            Some(GitFailureCode::PreconditionChanged),
            "{result:?}"
        );
        let done = f.store.operation("op").unwrap().unwrap();
        assert_source(&f, &done);
        assert_eq!(done.request, saved.request);
        assert_eq!(done.preservation_plan, saved.preservation_plan);
        assert_eq!(&done.steps[..saved.steps.len()], saved.steps.as_slice());
        let rejected = done.not_executed_checkout().unwrap();
        assert_eq!(rejected.sequence, 4);
        assert_eq!(rejected.task_id.as_deref(), Some(result.task_id.as_str()));
        assert!(rejected.after_fingerprint.is_none());
        let observed = done.source_recovery().unwrap();
        assert_eq!(observed.sequence, 5);
        assert_eq!(observed.task_id, rejected.task_id);
        assert!(done.steps[4..]
            .iter()
            .all(|s| s.task_id == rejected.task_id));
        assert!(f
            .store
            .confirm_checkout_not_executed("op", done.version, &result.task_id)
            .is_err());
        let receipt = f.store.operation_action("op", "original").unwrap().unwrap();
        assert_eq!(receipt.status, OperationActionStatus::Failed);
        assert_eq!(receipt.result_version, Some(done.version));
        if case >= 2 {
            let old = receipt.planned_step.as_ref().unwrap();
            assert_eq!(old.status, OperationStepStatus::Planned);
            assert_ne!(old.task_id, rejected.task_id);
        } else {
            assert!(receipt.planned_step.is_none());
        }
        assert_eq!(
            service
                .submit(
                    &f.tasks,
                    RequestAccess::ReadWrite,
                    "repo",
                    "op",
                    receipt.request.clone()
                )
                .await
                .unwrap()
                .action,
            receipt
        );
        let public = OperationRecoveryResponse::from(
            OperationQueryService {
                store: f.store.clone(),
            }
            .get(RequestAccess::ReadOnly, "repo", "op")
            .await
            .unwrap(),
        );
        let json = serde_json::to_value(public).unwrap();
        assert_eq!(json["steps"][4]["status"], "notExecuted");
        assert_eq!(json["steps"][4]["taskId"], result.task_id);
        assert_eq!(json["steps"][5]["kind"], "sourceRecovery");
        assert_eq!(json["actionsEnabled"], false);
        assert_eq!(json["allowedActions"], serde_json::json!([]));
        if let Some((path, bytes)) = object {
            assert!(!path.exists());
            std::fs::write(path, bytes).unwrap();
        }
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn not_executed_checkout_retains_external_edits_and_resumes_source_only_after_exact_repair_and_restart(
) {
    let f = fixture_with(false, false, PreservationPolicy::KeepOnSourceBranch, false).await;
    preserve(&f).await;
    let service = actions(&f, Mutation::Source);
    let original = submit(
        &f.tasks,
        &service,
        &f.store,
        "original",
        OperationActionKind::CompletePreparedCheckout,
    )
    .await;
    assert_eq!(
        original.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    let waiting = f.store.operation("op").unwrap().unwrap();
    assert!(waiting.not_executed_checkout().is_some());
    assert!(waiting.source_recovery().is_none());
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "external after intent\n"
    );
    assert!(OperationActionKind::RestoreSourceChanges.allowed(&waiting));
    for kind in [
        OperationActionKind::AbandonPlannedCheckout,
        OperationActionKind::ResumePlannedCheckout,
        OperationActionKind::ReconcileCheckout,
    ] {
        assert!(!kind.allowed(&waiting));
    }
    let before = waiting.steps.clone();
    let failed = submit(
        &f.tasks,
        &service,
        &f.store,
        "unfixed",
        OperationActionKind::RestoreSourceChanges,
    )
    .await;
    assert_eq!(
        failed.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(f.store.operation("op").unwrap().unwrap().steps, before);
    f.tasks.begin_shutdown().await;
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let store = Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
    let access = WriteAccess::new(Arc::new(f.saves.targets.clone()), store.clone());
    access.recover_interrupted().await.unwrap();
    store.recover_interrupted_actions().unwrap();
    let restarted = store.operation("op").unwrap().unwrap();
    assert_eq!(restarted.steps, before);
    assert_eq!(restarted.state, waiting.state);
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let mut recovered = service.clone();
    recovered.store = store.clone();
    recovered.restore.checkout.saves.operations = store.clone();
    recovered.restore.checkout.saves.shelves = store.clone();
    std::fs::write(f.repository.path().join("a"), "base\n").unwrap();
    git(
        f.repository.path(),
        &["update-ref", "refs/heads/other", "HEAD"],
    );
    let receipt = store.operation_action("op", "unfixed").unwrap().unwrap();
    assert_eq!(
        recovered
            .submit(
                &tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                receipt.request.clone()
            )
            .await
            .unwrap()
            .action,
        receipt
    );
    assert_eq!(
        submit(
            &tasks,
            &recovered,
            &store,
            "restore",
            OperationActionKind::RestoreSourceChanges
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    let done = store.operation("op").unwrap().unwrap();
    assert_source(&f, &done);
    assert_eq!(&done.steps[..before.len()], before.as_slice());
    assert_eq!(
        done.source_recovery().unwrap().task_id.as_deref(),
        store
            .operation_action("op", "restore")
            .unwrap()
            .unwrap()
            .task_id
            .as_deref()
    );
    tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn not_executed_checkout_receipt_failure_retains_unknown_intent_without_manufacturing_proof_after_restart(
) {
    for trigger in [
        "CREATE TRIGGER reject_receipt BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.status')='notExecuted' BEGIN SELECT RAISE(ABORT,'receipt failure'); END;",
        "CREATE TRIGGER reject_receipt BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.status')='notExecuted' BEGIN SELECT RAISE(IGNORE); END;",
    ] {
        let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
        preserve(&f).await;
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        db.execute_batch(trigger).unwrap();
        let result = submit(&f.tasks, &actions(&f, Mutation::Target), &f.store, "original", OperationActionKind::CompletePreparedCheckout).await;
        assert_eq!(result.failure_code, Some(GitFailureCode::OutcomeUnknown));
        let uncertain = f.store.operation("op").unwrap().unwrap();
        assert_eq!(uncertain.steps.last().unwrap().status, OperationStepStatus::Unknown);
        assert!(uncertain.not_executed_checkout().is_none());
        assert!(!OperationActionKind::RestoreSourceChanges.allowed(&uncertain));
        assert!(uncertain.backups.iter().all(|b| b.disposition == BackupDisposition::Retained));
        db.execute_batch("DROP TRIGGER reject_receipt").unwrap();
        assert!(f.store.confirm_checkout_not_executed("op", uncertain.version, &result.task_id).is_err());
        let reconcile = f.checkout.submit_reconcile(&f.tasks, &uncertain).await.unwrap();
        assert_eq!(finished(&f.tasks, &reconcile.task_id).await.failure_code, Some(GitFailureCode::PreconditionChanged));
        assert_eq!(f.store.operation("op").unwrap().unwrap(), uncertain);
        let reopened = RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap();
        assert!(reopened.confirm_checkout_not_executed("op", uncertain.version, &result.task_id).is_err());
        assert_eq!(git(f.repository.path(), &["branch", "--show-current"]), "main");
        assert_eq!(std::fs::read_to_string(f.repository.path().join("a")).unwrap(), "base\n");
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn not_executed_checkout_source_capture_planned_can_be_taken_over_without_rewriting_the_rejected_actor(
) {
    for planned in [false, true] {
        let f = fixture_with(false, false, PreservationPolicy::KeepOnSourceBranch, false).await;
        preserve(&f).await;
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        db.execute_batch(if planned {
        "CREATE TRIGGER reject_capture BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='captureIndex' AND json_extract(NEW.step_json,'$.status')='intentRecorded' BEGIN SELECT RAISE(ABORT,'capture intent failure'); END;"
    } else {
        "CREATE TRIGGER reject_capture BEFORE INSERT ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='captureIndex' BEGIN SELECT RAISE(ABORT,'capture planning failure'); END;"
    }).unwrap();
        let service = actions(&f, Mutation::Target);
        let result = submit(
            &f.tasks,
            &service,
            &f.store,
            "original",
            OperationActionKind::CompletePreparedCheckout,
        )
        .await;
        assert_eq!(result.failure_code, Some(GitFailureCode::OutcomeUnknown));
        let waiting = f.store.operation("op").unwrap().unwrap();
        let rejected = waiting.not_executed_checkout().unwrap().clone();
        assert_eq!(
            waiting.steps.last().unwrap().status,
            if planned {
                OperationStepStatus::Planned
            } else {
                OperationStepStatus::Verified
            }
        );
        assert!(waiting.source_recovery().is_some());
        let kind = if planned {
            OperationActionKind::ResumePlannedRestoration
        } else {
            OperationActionKind::ResumeRestoration
        };
        assert!(kind.allowed(&waiting));
        db.execute_batch("DROP TRIGGER reject_capture").unwrap();
        assert_eq!(
            submit(&f.tasks, &service, &f.store, "restore", kind)
                .await
                .status,
            TaskStatus::Succeeded
        );
        let done = f.store.operation("op").unwrap().unwrap();
        assert_source(&f, &done);
        assert_eq!(done.not_executed_checkout(), Some(&rejected));
        assert_eq!(
            f.store
                .operation_action("op", "restore")
                .unwrap()
                .unwrap()
                .planned_step
                .as_ref(),
            if planned { waiting.steps.last() } else { None }
        );
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn not_executed_checkout_unknown_capture_and_restore_are_reconciled_without_replaying_the_rejected_execute(
) {
    for kind in [OperationStepKind::CaptureIndex, OperationStepKind::Restore] {
        let f = fixture_with(false, false, PreservationPolicy::KeepOnSourceBranch, false).await;
        preserve(&f).await;
        let db = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        let step_name = if kind == OperationStepKind::CaptureIndex {
            "captureIndex"
        } else {
            "restore"
        };
        db.execute_batch(&format!("CREATE TRIGGER reject_verification BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json,'$.kind')='{step_name}' AND json_extract(NEW.step_json,'$.status')='verified' BEGIN SELECT RAISE(ABORT,'verification failure'); END;")).unwrap();
        let service = actions(&f, Mutation::Target);
        let first = submit(
            &f.tasks,
            &service,
            &f.store,
            "original",
            OperationActionKind::CompletePreparedCheckout,
        )
        .await;
        assert_eq!(first.failure_code, Some(GitFailureCode::OutcomeUnknown));
        let uncertain = f.store.operation("op").unwrap().unwrap();
        let rejected = uncertain.not_executed_checkout().unwrap().clone();
        assert_eq!(uncertain.steps.last().unwrap().kind, kind);
        assert_eq!(
            uncertain.steps.last().unwrap().status,
            OperationStepStatus::Unknown
        );
        assert!(!OperationActionKind::RestoreSourceChanges.allowed(&uncertain));
        assert!(!OperationActionKind::ResumeRestoration.allowed(&uncertain));
        assert!(!OperationActionKind::AbandonPlannedCheckout.allowed(&uncertain));
        db.execute_batch("DROP TRIGGER reject_verification")
            .unwrap();
        let index = std::fs::read(f.repository.path().join(".git/index")).unwrap();
        let refs = git(f.repository.path(), &["show-ref"]);
        let contents = std::fs::read(f.repository.path().join("a")).unwrap();
        let reconcile = if kind == OperationStepKind::CaptureIndex {
            OperationActionKind::ReconcileCapture
        } else {
            OperationActionKind::ReconcileRestore
        };
        assert_eq!(
            submit(&f.tasks, &service, &f.store, "verify", reconcile)
                .await
                .status,
            TaskStatus::Succeeded
        );
        assert_eq!(
            std::fs::read(f.repository.path().join(".git/index")).unwrap(),
            index
        );
        assert_eq!(git(f.repository.path(), &["show-ref"]), refs);
        assert_eq!(
            std::fs::read(f.repository.path().join("a")).unwrap(),
            contents
        );
        let verified = f.store.operation("op").unwrap().unwrap();
        assert_eq!(verified.not_executed_checkout(), Some(&rejected));
        assert_eq!(
            verified.steps.last().unwrap().task_id,
            uncertain.steps.last().unwrap().task_id
        );
        let resume = if kind == OperationStepKind::CaptureIndex {
            OperationActionKind::ResumeCapture
        } else {
            OperationActionKind::ResumeRestoration
        };
        assert_eq!(
            submit(&f.tasks, &service, &f.store, "restore", resume)
                .await
                .status,
            TaskStatus::Succeeded
        );
        if kind == OperationStepKind::CaptureIndex {
            // ResumeCapture authorizes this one captured group, not the rest
            // of the operation. Completion requires a separate explicit action.
            let partial = f.store.operation("op").unwrap().unwrap();
            assert_eq!(partial.state.phase, OperationPhase::Restoring);
            assert_eq!(partial.state.status, OperationStatus::Running);
            assert_eq!(
                partial
                    .backups
                    .iter()
                    .filter(|b| b.disposition == BackupDisposition::Restored)
                    .count(),
                1
            );
            assert_eq!(
                std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
                "staged\n"
            );
            assert!(!f.repository.path().join("new").exists());
            assert_eq!(
                submit(
                    &f.tasks,
                    &service,
                    &f.store,
                    "remaining",
                    OperationActionKind::ResumeRestoration
                )
                .await
                .status,
                TaskStatus::Succeeded
            );
        }
        let done = f.store.operation("op").unwrap().unwrap();
        assert_source(&f, &done);
        assert_eq!(done.not_executed_checkout(), Some(&rejected));
        assert_eq!(
            f.store
                .operation_action("op", "original")
                .unwrap()
                .unwrap()
                .status,
            OperationActionStatus::Failed
        );
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn not_executed_checkout_receipt_requires_the_running_intent_actor_and_rolls_back_all_evidence_on_failure(
) {
    let f = fixture_with(false, false, PreservationPolicy::Restore, false).await;
    let saved = preserve(&f).await;
    let store = f.store.clone();
    let data = f._data.path().join("core.sqlite");
    let task = f.tasks.submit_operation(&saved, "checkoutRejectionStorage", move |context| async move {
        let operation = store.operation("op").unwrap().unwrap();
        let step = OperationStep {
            sequence: operation.steps.len() as u32,
            kind: OperationStepKind::Execute,
            status: OperationStepStatus::Planned,
            input_fingerprint: format!("{:x}", Sha256::digest(serde_json::to_vec(&operation.request.command).unwrap())),
            before_fingerprint: operation.steps.last().unwrap().after_fingerprint.clone(),
            after_fingerprint: None, task_id: Some(context.task_id().into()), backup_id: None, failure_code: None, source_objects: None,
            source_recovery_outcome: None,
        };
        let state = OperationState { phase: OperationPhase::Executing, status: OperationStatus::Running, wait_reason: None, failure_code: None, result_head_oid: None };
        let planned = store.update_operation("op", operation.version, OperationUpdate { state: state.clone(), step: Some(step.clone()), backup: None }).unwrap();
        assert!(store.confirm_checkout_not_executed("op", planned.version, context.task_id()).is_err());
        let intent = store.update_operation("op", planned.version, OperationUpdate { state, step: Some(OperationStep { status: OperationStepStatus::IntentRecorded, ..step }), backup: None }).unwrap();
        let mut fabricated = intent.steps.last().unwrap().clone();
        fabricated.status = OperationStepStatus::NotExecuted;
        fabricated.failure_code = Some(GitFailureCode::PreconditionChanged);
        assert!(store.update_operation("op", intent.version, OperationUpdate { state: intent.state.clone(), step: Some(fabricated), backup: None }).is_err());
        assert!(store.confirm_checkout_not_executed("op", intent.version, "wrong").is_err());
        assert!(store.confirm_checkout_not_executed("op", intent.version - 1, context.task_id()).is_err());
        let db = rusqlite::Connection::open(data).unwrap();
        let before = store.recovery_snapshot("repo", "op").unwrap();
        for status in ["queued", "failed"] {
            db.execute("UPDATE tasks SET status=?1 WHERE task_id=?2", rusqlite::params![status, context.task_id()]).unwrap();
            assert!(store.confirm_checkout_not_executed("op", intent.version, context.task_id()).is_err());
        }
        db.execute("UPDATE tasks SET status='running' WHERE task_id=?1", [context.task_id()]).unwrap();
        db.execute("UPDATE tasks SET snapshot_json=json_set(snapshot_json,'$.repoId','wrong-repo') WHERE task_id=?1", [context.task_id()]).unwrap();
        assert!(store.confirm_checkout_not_executed("op", intent.version, context.task_id()).is_err());
        db.execute("UPDATE tasks SET snapshot_json=json_set(snapshot_json,'$.repoId','repo') WHERE task_id=?1", [context.task_id()]).unwrap();
        for trigger in [
            "CREATE TRIGGER reject_live BEFORE UPDATE ON git_operation_steps BEGIN SELECT RAISE(ABORT,'step failure'); END;",
            "CREATE TRIGGER reject_live BEFORE UPDATE OF state_json ON git_operations BEGIN SELECT RAISE(ABORT,'state failure'); END;",
            "CREATE TRIGGER reject_live BEFORE UPDATE ON git_operation_steps BEGIN SELECT RAISE(IGNORE); END;",
        ] {
            db.execute_batch(trigger).unwrap();
            assert!(store.confirm_checkout_not_executed("op", intent.version, context.task_id()).is_err());
            assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), before);
            db.execute_batch("DROP TRIGGER reject_live").unwrap();
        }
        db.execute_batch("UPDATE git_operation_steps SET sequence=9 WHERE operation_id='op' AND sequence=4;").unwrap();
        let corrupted = store.recovery_snapshot("repo", "op").unwrap();
        assert!(store.confirm_checkout_not_executed("op", intent.version, context.task_id()).is_err());
        assert_eq!(store.recovery_snapshot("repo", "op").unwrap(), corrupted);
        db.execute_batch("UPDATE git_operation_steps SET sequence=4 WHERE operation_id='op' AND sequence=9;").unwrap();
        let rejected = store.confirm_checkout_not_executed("op", intent.version, context.task_id()).unwrap();
        assert_eq!(rejected.version, intent.version + 1);
        assert!(rejected.not_executed_checkout().is_some());
        assert!(store.confirm_checkout_not_executed("op", rejected.version, context.task_id()).is_err());
        for status in [OperationStepStatus::IntentRecorded, OperationStepStatus::Unknown, OperationStepStatus::Verified] {
            let changed = OperationStep { status, ..rejected.steps.last().unwrap().clone() };
            assert!(store.update_operation("op", rejected.version, OperationUpdate { state: rejected.state.clone(), step: Some(changed), backup: None }).is_err());
        }
        Ok(None)
    }).await.unwrap();
    let done = finished(&f.tasks, &task.task_id).await;
    assert_eq!(done.status, TaskStatus::Succeeded, "{done:?}");
    let rejected = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        rejected.not_executed_checkout().unwrap().task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    assert_eq!(
        submit(
            &f.tasks,
            &actions(&f, Mutation::Target),
            &f.store,
            "restore",
            OperationActionKind::RestoreSourceChanges
        )
        .await
        .status,
        TaskStatus::Succeeded
    );
    assert_source(&f, &f.store.operation("op").unwrap().unwrap());
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
