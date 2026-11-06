use super::*;
use crate::{
    domain::task::{TaskSnapshot, TaskStatus},
    features::operations::checkout::tests::{fixture_with, preserve},
    ports::{
        operations::{OperationStoreError, OperationStorePort},
        shelves::ShelfStorePort,
    },
    storage::RepositoryStore,
};
use std::{process::Command, time::Duration};

struct FailCheckoutConfirmation(Arc<RepositoryStore>);
impl OperationStorePort for FailCheckoutConfirmation {
    fn operation_request(
        &self,
        repo: &str,
        id: &str,
    ) -> Result<Option<GitOperation>, OperationStoreError> {
        self.0.operation_request(repo, id)
    }
    fn create_operation(&self, value: NewOperation) -> Result<GitOperation, OperationStoreError> {
        self.0.create_operation(value)
    }
    fn operation(&self, id: &str) -> Result<Option<GitOperation>, OperationStoreError> {
        self.0.operation(id)
    }
    fn active_operations(&self) -> Result<Vec<GitOperation>, OperationStoreError> {
        self.0.active_operations()
    }
    fn operation_owner(&self, resource: &str) -> Result<Option<String>, OperationStoreError> {
        self.0.operation_owner(resource)
    }
    fn repository_operation_owner(
        &self,
        repo: &str,
    ) -> Result<Option<String>, OperationStoreError> {
        self.0.repository_operation_owner(repo)
    }
    fn record_preservation_plan(
        &self,
        id: &str,
        version: i64,
        plan: OperationPreservationPlan,
    ) -> Result<GitOperation, OperationStoreError> {
        self.0.record_preservation_plan(id, version, plan)
    }
    fn update_operation(
        &self,
        id: &str,
        version: i64,
        update: OperationUpdate,
    ) -> Result<GitOperation, OperationStoreError> {
        if update.step.as_ref().is_some_and(|s| {
            s.kind == OperationStepKind::Execute && s.status == OperationStepStatus::Verified
        }) {
            return Err(OperationStoreError::Unavailable);
        }
        self.0.update_operation(id, version, update)
    }
}
async fn finished(tasks: &TaskService, id: &str) -> TaskSnapshot {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let task = tasks.get(id).await.unwrap();
            if task.status.is_terminal() {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
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
async fn checkout_reconcile_confirms_after_database_reopen_without_replaying_or_restoring() {
    for detached in [false, true] {
        let f = fixture_with(detached, true, PreservationPolicy::Restore, false).await;
        let saved = preserve(&f).await;
        let mut broken = f.checkout.clone();
        broken.saves.operations = Arc::new(FailCheckoutConfirmation(f.store.clone()));
        let task = broken.submit_preserved(&f.tasks, &saved).await.unwrap();
        assert_eq!(
            finished(&f.tasks, &task.task_id).await.failure_code,
            Some(GitFailureCode::OutcomeUnknown)
        );
        let uncertain = f.store.operation("op").unwrap().unwrap();
        assert_eq!(
            uncertain.steps.last().unwrap().status,
            OperationStepStatus::Unknown
        );
        assert_eq!(uncertain.state.phase, OperationPhase::Executing);
        let reopened =
            Arc::new(RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap());
        let mut recovered = f.checkout.clone();
        recovered.saves.operations = reopened.clone();
        recovered.saves.shelves = reopened.clone();
        let path = f.repository.path();
        let index = std::fs::read(path.join(".git/index")).unwrap();
        let head = git(path, &["rev-parse", "HEAD"]);
        let refs = git(path, &["show-ref"]);
        let reconcile = recovered
            .submit_reconcile(&f.tasks, &uncertain)
            .await
            .unwrap();
        let result = finished(&f.tasks, &reconcile.task_id).await;
        assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
        let confirmed = reopened.operation("op").unwrap().unwrap();
        assert_eq!(confirmed.version, uncertain.version + 1);
        assert_eq!(confirmed.state.phase, OperationPhase::Restoring);
        assert_eq!(confirmed.state.status, OperationStatus::Running);
        assert_eq!(
            confirmed.state.result_head_oid.as_deref(),
            Some(head.as_str())
        );
        assert!(confirmed.state.failure_code.is_none() && confirmed.state.wait_reason.is_none());
        let execute = confirmed.steps.last().unwrap();
        assert_eq!(execute.status, OperationStepStatus::Verified);
        assert_eq!(execute.task_id.as_deref(), Some(task.task_id.as_str()));
        assert_ne!(execute.task_id.as_deref(), Some(reconcile.task_id.as_str()));
        assert_eq!(confirmed.backups, uncertain.backups);
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        assert_eq!(git(path, &["show-ref"]), refs);
        assert_eq!(std::fs::read_to_string(path.join("a")).unwrap(), "other\n");
        assert!(!path.join("new").exists());
        assert_eq!(reopened.list_shelf_snapshots("repo").unwrap().len(), 2);
        assert!(reopened
            .operation_owner(&confirmed.resource_key)
            .unwrap()
            .is_some());
        let repeated = recovered
            .submit_reconcile(&f.tasks, &confirmed)
            .await
            .unwrap();
        assert_eq!(
            finished(&f.tasks, &repeated.task_id).await.failure_code,
            Some(GitFailureCode::PreconditionChanged)
        );
        f.tasks.drain_workers(Duration::from_secs(2)).await;
        assert_eq!(reopened.operation("op").unwrap().unwrap(), confirmed);
    }
}

#[tokio::test]
async fn checkout_reconcile_refuses_dirty_or_wrong_branch_and_preserves_unknown_evidence() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let saved = preserve(&f).await;
    let mut broken = f.checkout.clone();
    broken.saves.operations = Arc::new(FailCheckoutConfirmation(f.store.clone()));
    let task = broken.submit_preserved(&f.tasks, &saved).await.unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::OutcomeUnknown)
    );
    let uncertain = f.store.operation("op").unwrap().unwrap();
    let path = f.repository.path();
    std::fs::write(path.join("b"), "external b\n").unwrap();
    let reconcile = f
        .checkout
        .submit_reconcile(&f.tasks, &uncertain)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &reconcile.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(f.store.operation("op").unwrap().unwrap(), uncertain);
    assert_eq!(
        std::fs::read_to_string(path.join("b")).unwrap(),
        "external b\n"
    );
    git(path, &["restore", "--worktree", "--", "b"]);
    git(path, &["switch", "--detach", "HEAD"]);
    let reconcile = f
        .checkout
        .submit_reconcile(&f.tasks, &uncertain)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &reconcile.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(f.store.operation("op").unwrap().unwrap(), uncertain);
    assert_eq!(git(path, &["branch", "--show-current"]), "");
    assert!(f
        .store
        .operation_owner(&uncertain.resource_key)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn checkout_reconcile_refuses_ordinary_context_without_journal_mutation() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let service = f.checkout.clone();
    let task = f
        .tasks
        .submit(
            None,
            None,
            "unrelated",
            "invalidReconcile",
            move |context| async move { service.reconcile("op", &context).await.map(|_| None) },
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
