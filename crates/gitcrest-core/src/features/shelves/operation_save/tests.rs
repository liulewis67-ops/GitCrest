use super::*;
use crate::{
    domain::{diff::DiffScope, task::TaskStatus},
    execution::write_access::WriteAccess,
    git::repository::GitRepositoryAdapter,
    ports::git::GitReadPort,
    storage::{
        diff::DiffWorktreeAdapter, repository_paths::RepositoryFilesystemAdapter, RepositoryStore,
    },
};
use std::{path::Path, time::Duration};

fn source_git(path: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
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
async fn operation_save_source_roots_survive_branch_replacement_and_immediate_git_gc() {
    let f = fixture().await;
    let path = f.repository.path();
    let plan = f.service.prepare_plan("repo", "backup", "").await.unwrap();
    let task = f
        .service
        .submit_plan(&f.tasks, &f.operation, plan)
        .await
        .unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let operation = f.store.operation("op").unwrap().unwrap();
    let step = operation
        .steps
        .iter()
        .find(|s| s.kind == OperationStepKind::Clean)
        .unwrap();
    let roots = step.source_objects.as_ref().unwrap();
    assert!(roots.matches_step("op", step));
    assert_eq!(
        source_git(path, &["show", &format!("{}:a", roots.index_reference)]),
        "staged a"
    );
    let replacement = source_git(
        path,
        &[
            "commit-tree",
            "HEAD^{tree}",
            "-m",
            "independent replacement",
        ],
    );
    source_git(path, &["update-ref", "refs/heads/main", &replacement]);
    source_git(path, &["branch", "-D", "other"]);
    source_git(path, &["reflog", "expire", "--expire=now", "--all"]);
    source_git(path, &["gc", "--quiet", "--prune=now"]);
    assert_eq!(
        source_git(
            path,
            &["rev-parse", &format!("{}^{{commit}}", roots.head_reference)]
        ),
        roots.head_oid
    );
    assert_eq!(
        source_git(path, &["show", &format!("{}:a", roots.index_reference)]),
        "staged a"
    );
    assert_eq!(
        source_git(path, &["show", &format!("{}:a", roots.head_reference)]),
        "base a"
    );
    let reopened = RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap();
    assert_eq!(reopened.operation("op").unwrap().unwrap(), operation);
}

#[tokio::test]
async fn operation_save_missing_source_ref_stops_the_next_cleanup_without_recreating_evidence() {
    let f = fixture().await;
    let path = f.repository.path();
    let working = group(&f.service, path, DiffScope::WorkingTree, 0, 1).await;
    let task = f
        .service
        .submit_group(&f.tasks, &f.operation, working)
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::Succeeded
    );
    let saved = f.store.operation("op").unwrap().unwrap();
    let roots = saved.steps[1].source_objects.as_ref().unwrap();
    source_git(
        path,
        &[
            "update-ref",
            "-d",
            &roots.index_reference,
            &roots.index_tree_oid,
        ],
    );
    let indexed = group(&f.service, path, DiffScope::Index, 1, 0).await;
    let task = f
        .service
        .submit_group(&f.tasks, &saved, indexed)
        .await
        .unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Failed);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.state.status, OperationStatus::RecoveryRequired);
    assert_eq!(
        stopped.steps.last().unwrap().status,
        OperationStepStatus::Unknown
    );
    assert_eq!(source_git(path, &["show", ":a"]), "staged a");
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "staged a\n"
    );
    let missing = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--verify", &roots.index_reference])
        .output()
        .unwrap();
    assert!(!missing.status.success());
    assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
}

struct PlanCheckingShelves(Arc<RepositoryStore>);
impl ShelfStorePort for PlanCheckingShelves {
    fn list_shelf_snapshots(
        &self,
        repo: &str,
    ) -> Result<Vec<ShelfSnapshot>, crate::domain::error::RepositoryError> {
        self.0.list_shelf_snapshots(repo)
    }
    fn read_shelf_record(
        &self,
        repo: &str,
        id: &str,
    ) -> Result<Option<ShelfRecord>, crate::domain::error::RepositoryError> {
        self.0.read_shelf_record(repo, id)
    }
    fn save_shelf_record(
        &self,
        shelf: ShelfRecord,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        let operation = self.0.operation("op").unwrap().unwrap();
        let plan = operation
            .preservation_plan
            .as_ref()
            .expect("full plan must precede first artifact write");
        assert_eq!(plan.groups.len(), 2);
        assert_eq!(
            plan.source_fingerprint,
            operation.request.changes_fingerprint
        );
        assert!(operation
            .steps
            .iter()
            .all(|s| s.task_id.as_deref() == Some(plan.task_id.as_str())));
        self.0.save_shelf_record(shelf)
    }
    fn delete_shelf_record(
        &self,
        repo: &str,
        id: &str,
    ) -> Result<bool, crate::domain::error::RepositoryError> {
        self.0.delete_shelf_record(repo, id)
    }
}

#[tokio::test]
async fn operation_save_plan_runs_all_groups_in_one_owner_task_without_nested_scheduling() {
    let mut f = fixture().await;
    f.service.shelves = Arc::new(PlanCheckingShelves(f.store.clone()));
    let plan = f.service.prepare_plan("repo", "backup", "").await.unwrap();
    let task = f
        .service
        .submit_plan(&f.tasks, &f.operation, plan)
        .await
        .unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let operation = f.store.operation("op").unwrap().unwrap();
    let persisted = operation.preservation_plan.as_ref().unwrap();
    assert_eq!(persisted.task_id, task.task_id);
    assert_eq!(persisted.groups[0].selections.len(), 3);
    assert_eq!(persisted.groups[1].selections.len(), 1);
    let reopened = RepositoryStore::open(&f._data.path().join("core.sqlite")).unwrap();
    assert_eq!(reopened.operation("op").unwrap().unwrap(), operation);
    assert_eq!(operation.steps.len(), 4);
    assert!(operation
        .steps
        .iter()
        .all(|s| s.status == OperationStepStatus::Verified
            && s.task_id.as_deref() == Some(task.task_id.as_str())));
    assert_eq!(operation.backups.len(), 2);
    assert_eq!(operation.backups[0].scope, OperationBackupScope::Index);
    assert_eq!(operation.backups[0].restore_order, 0);
    assert_eq!(
        operation.backups[1].scope,
        OperationBackupScope::WorkingTree
    );
    assert_eq!(operation.backups[1].restore_order, 1);
    assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
    assert_eq!(operation.state.phase, OperationPhase::Saving);
    assert_eq!(operation.state.status, OperationStatus::Running);
    assert_eq!(
        f.store
            .operation_owner(&operation.resource_key)
            .unwrap()
            .as_deref(),
        Some("op")
    );
    assert!(f
        .service
        .commands
        .read_worktree_state(f.repository.path())
        .await
        .unwrap()
        .dirty_paths
        .is_empty());
    assert_eq!(
        f.service
            .commands
            .read_head_oid(f.repository.path())
            .await
            .unwrap(),
        operation.request.source_head_oid
    );
}

#[tokio::test]
async fn operation_save_plan_rejects_a_stale_later_group_before_saving_the_first_group() {
    let f = fixture().await;
    let mut plan = f.service.prepare_plan("repo", "backup", "").await.unwrap();
    assert_eq!(plan.groups.len(), 2);
    plan.groups[1].selections[0].revision = "stale-index-revision".into();
    let task = f
        .service
        .submit_plan(&f.tasks, &f.operation, plan)
        .await
        .unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Failed);
    assert_eq!(
        result.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let operation = f.store.operation("op").unwrap().unwrap();
    assert!(operation.steps.is_empty());
    assert!(operation.backups.is_empty());
    assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
    assert_eq!(operation.state.status, OperationStatus::RecoveryRequired);
    assert_eq!(
        operation.state.wait_reason,
        Some(OperationWaitReason::ExternalChange)
    );
    assert!(f
        .store
        .operation_owner(&operation.resource_key)
        .unwrap()
        .is_some());
    let path = f.repository.path();
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "working a\n"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("b")).unwrap(),
        "working b\n"
    );
    assert!(path.join("untracked").exists());
}

struct Fixture {
    store: Arc<RepositoryStore>,
    service: OperationSaveService,
    tasks: TaskService,
    operation: GitOperation,
    // Close SQLite handles before removing their Windows temporary directory.
    _data: tempfile::TempDir,
    repository: tempfile::TempDir,
}
async fn fixture() -> Fixture {
    let repository = super::super::evidence::tests::repository();
    let path = repository.path();
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["branch", "other"])
        .status()
        .unwrap()
        .success());
    let data = tempfile::tempdir().unwrap();
    let store = Arc::new(RepositoryStore::open(&data.path().join("core.sqlite")).unwrap());
    store.insert_test_repository_at("repo", path);
    let targets = RepositoryTargetReader::new(
        store.clone(),
        Arc::new(GitRepositoryAdapter),
        Arc::new(RepositoryFilesystemAdapter),
    );
    let commands = GitCommandService::default();
    let worktree = Arc::new(DiffWorktreeAdapter);
    let before = evidence::read_snapshot(&commands, worktree.as_ref(), "repo", path)
        .await
        .unwrap();
    let head = commands.read_head_oid(path).await.unwrap();
    let branch = commands.read_current_branch(path).await.unwrap();
    let access = WriteAccess::new(Arc::new(targets.clone()), store.clone());
    let operation = access
        .claim(NewOperation {
            operation_id: "op".into(),
            repo_id: "repo".into(),
            resource_key: "ignored".into(),
            request_id: "request".into(),
            request: OperationRequest {
                command: OperationCommand::Checkout {
                    target: "other".into(),
                    target_oid: head.clone().unwrap(),
                },
                source_head_oid: head,
                source_branch: branch,
                changes_fingerprint: before.fingerprint(),
                preservation: PreservationPolicy::Restore,
            },
        })
        .await
        .unwrap();
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let service = OperationSaveService {
        operations: store.clone(),
        shelves: store.clone(),
        targets,
        commands,
        worktree,
    };
    Fixture {
        repository,
        _data: data,
        store,
        service,
        tasks,
        operation,
    }
}
async fn group(
    service: &OperationSaveService,
    path: &Path,
    scope: DiffScope,
    save_order: u32,
    restore_order: u32,
) -> SaveGroup {
    let status = service
        .commands
        .read_status("repo".into(), path, &[])
        .await
        .unwrap();
    let mut selections = Vec::new();
    for file in status
        .files
        .iter()
        .filter(|file| file.has_changes_for_scope(scope))
    {
        let read = crate::features::diff::read_with_patch(
            &service.commands,
            service.worktree.as_ref(),
            "repo".into(),
            path,
            file,
            scope,
        )
        .await
        .unwrap();
        selections.push(ShelfSelection {
            path: file.path.clone(),
            scope,
            revision: read.document.revision,
            selections: vec![],
        });
    }
    SaveGroup {
        name: "Operation preservation".into(),
        description: String::new(),
        selections,
        save_order,
        restore_order,
    }
}
async fn finished(tasks: &TaskService, id: &str) -> crate::domain::task::TaskSnapshot {
    let result = tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            let task = tasks.get(id).await.unwrap();
            if task.status.is_terminal() {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    match result {
        Ok(task) => task,
        Err(error) => panic!(
            "Task {id} did not finish within the test deadline: {error}; last snapshot: {:?}",
            tasks.get(id).await
        ),
    }
}

#[tokio::test]
async fn operation_save_runs_two_real_groups_under_owner_tasks_and_persists_task_links() {
    let f = fixture().await;
    let path = f.repository.path();
    let plan = f
        .service
        .prepare_plan("repo", "Operation preservation", "")
        .await
        .unwrap();
    assert_eq!(
        plan.before.fingerprint(),
        f.operation.request.changes_fingerprint
    );
    assert!(plan.patch_bytes > 0);
    assert_eq!(plan.groups.len(), 2);
    let mut groups = plan.groups.into_iter();
    let working = groups.next().unwrap();
    let indexed = groups.next().unwrap();
    let task = f
        .service
        .submit_group(&f.tasks, &f.operation, working)
        .await
        .unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
    let current = f.store.operation("op").unwrap().unwrap();
    assert_eq!(current.steps.len(), 2);
    assert!(current
        .steps
        .iter()
        .all(|step| step.status == OperationStepStatus::Verified
            && step.task_id.as_deref() == Some(task.task_id.as_str())));
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "staged a\n"
    );
    assert!(!path.join("untracked").exists());
    let second = f
        .service
        .submit_group(&f.tasks, &current, indexed)
        .await
        .unwrap();
    let result = finished(&f.tasks, &second.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let current = f.store.operation("op").unwrap().unwrap();
    assert_eq!(current.steps.len(), 4);
    assert!(current.steps[2..]
        .iter()
        .all(|step| step.status == OperationStepStatus::Verified
            && step.task_id.as_deref() == Some(second.task_id.as_str())));
    assert_eq!(current.backups.len(), 2);
    assert_eq!(current.backups[0].scope, OperationBackupScope::Index);
    assert_eq!(current.backups[1].scope, OperationBackupScope::WorkingTree);
    assert!(current
        .backups
        .iter()
        .all(|backup| backup.disposition == BackupDisposition::Retained));
    assert_eq!(current.state.phase, OperationPhase::Saving);
    assert_eq!(current.state.status, OperationStatus::Running);
    assert!(f
        .store
        .operation_owner(&current.resource_key)
        .unwrap()
        .is_some());
    assert!(f
        .service
        .commands
        .read_worktree_state(path)
        .await
        .unwrap()
        .dirty_paths
        .is_empty());
    assert_eq!(
        f.service.commands.read_head_oid(path).await.unwrap(),
        f.operation.request.source_head_oid
    );
    assert_eq!(
        f.service
            .commands
            .read_current_branch(path)
            .await
            .unwrap()
            .as_deref(),
        Some("main")
    );
}

#[tokio::test]
async fn operation_save_rejects_external_edits_before_intent_and_keeps_their_contents() {
    let f = fixture().await;
    let path = f.repository.path();
    let working = group(&f.service, path, DiffScope::WorkingTree, 0, 0).await;
    std::fs::write(path.join("a"), "external a\n").unwrap();
    let task = f
        .service
        .submit_group(&f.tasks, &f.operation, working)
        .await
        .unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Failed);
    assert_eq!(
        result.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let current = f.store.operation("op").unwrap().unwrap();
    assert_eq!(current.state.status, OperationStatus::RecoveryRequired);
    assert_eq!(
        current.state.wait_reason,
        Some(OperationWaitReason::ExternalChange)
    );
    assert!(current.steps.is_empty());
    assert!(current.backups.is_empty());
    assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "external a\n"
    );
}

#[tokio::test]
async fn operation_save_cannot_run_from_an_ordinary_task_context() {
    let f = fixture().await;
    let path = f.repository.path();
    let working = group(&f.service, path, DiffScope::WorkingTree, 0, 0).await;
    let before = evidence::read_snapshot(
        &f.service.commands,
        f.service.worktree.as_ref(),
        "repo",
        path,
    )
    .await
    .unwrap();
    let service = f.service.clone();
    let task = f
        .tasks
        .submit(
            None,
            None,
            "unrelated",
            "misrouted",
            move |context| async move {
                service
                    .run_group("op", working, context)
                    .await
                    .map(|_| None)
            },
        )
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::Failed
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(
        f.store.operation("op").unwrap().unwrap().version,
        f.operation.version
    );
    assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
    assert_eq!(
        evidence::read_snapshot(
            &f.service.commands,
            f.service.worktree.as_ref(),
            "repo",
            path
        )
        .await
        .unwrap(),
        before
    );
}
