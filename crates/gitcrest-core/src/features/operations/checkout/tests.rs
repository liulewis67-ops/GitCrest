use super::*;
use crate::{
    domain::task::TaskStatus,
    execution::write_access::WriteAccess,
    features::repositories::RepositoryTargetReader,
    git::{command::GitCommandService, refs::GitBranchAdapter, repository::GitRepositoryAdapter},
    ports::{git::GitReadPort, operations::OperationStorePort, shelves::ShelfStorePort},
    storage::{
        diff::DiffWorktreeAdapter, repository_paths::RepositoryFilesystemAdapter, RepositoryStore,
    },
};
use std::{process::Command, time::Duration};

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

pub(crate) struct Fixture {
    pub store: Arc<RepositoryStore>,
    pub saves: OperationSaveService,
    pub checkout: OperationCheckoutService,
    pub tasks: TaskService,
    pub operation: GitOperation,
    pub _data: tempfile::TempDir,
    pub repository: tempfile::TempDir,
}
async fn fixture(detached: bool) -> Fixture {
    fixture_with(detached, true, PreservationPolicy::Restore, false).await
}
pub(crate) async fn fixture_with(
    detached: bool,
    target_overlap: bool,
    policy: PreservationPolicy,
    stage_b: bool,
) -> Fixture {
    let repository = crate::features::operations::preview::tests::repository();
    let path = repository.path();
    if !target_overlap {
        let commit = git(
            path,
            &[
                "commit-tree",
                "HEAD^{tree}",
                "-p",
                "HEAD",
                "-m",
                "target tree unchanged",
            ],
        );
        git(path, &["update-ref", "refs/heads/other", &commit]);
    }
    if stage_b {
        std::fs::write(path.join("b"), "staged b\n").unwrap();
        git(path, &["add", "b"]);
        std::fs::write(path.join("b"), "working b\n").unwrap();
        std::fs::write(path.join("a"), "working\n").unwrap();
    } else {
        std::fs::write(path.join("a"), "staged\n").unwrap();
        git(path, &["add", "a"]);
        std::fs::write(path.join("a"), "working\n").unwrap();
        std::fs::write(path.join("b"), "local b\n").unwrap();
    }
    std::fs::write(path.join("new"), "untracked\n").unwrap();
    fixture_from_repository(repository, detached, policy).await
}
pub(crate) async fn fixture_from_repository(
    repository: tempfile::TempDir,
    detached: bool,
    policy: PreservationPolicy,
) -> Fixture {
    let path = repository.path();
    let data = tempfile::tempdir().unwrap();
    let store = Arc::new(RepositoryStore::open(&data.path().join("core.sqlite")).unwrap());
    store.insert_test_repository_at("repo", path);
    let targets = RepositoryTargetReader::new(
        store.clone(),
        Arc::new(GitRepositoryAdapter),
        Arc::new(RepositoryFilesystemAdapter),
    );
    let saves = OperationSaveService {
        operations: store.clone(),
        shelves: store.clone(),
        targets: targets.clone(),
        commands: GitCommandService::default(),
        worktree: Arc::new(DiffWorktreeAdapter),
    };
    let branches = Arc::new(GitBranchAdapter);
    let target = if detached {
        CheckoutTargetRequest::Commit(git(path, &["rev-parse", "refs/heads/other"]))
    } else {
        CheckoutTargetRequest::LocalBranch("other".into())
    };
    let preview = saves
        .preview_checkout(
            "repo",
            branches.as_ref(),
            CheckoutPreviewInput {
                target: &target,
                preservation: policy,
                shelf_name: "backup",
                shelf_description: "",
            },
        )
        .await
        .unwrap();
    let access = WriteAccess::new(Arc::new(targets), store.clone());
    let operation = access
        .claim(NewOperation {
            operation_id: "op".into(),
            repo_id: "repo".into(),
            resource_key: "ignored".into(),
            request_id: "request".into(),
            request: OperationRequest {
                command: preview.target.operation_command(),
                source_head_oid: Some(preview.source_head),
                source_branch: preview.source_branch,
                changes_fingerprint: evidence::read_snapshot(
                    &saves.commands,
                    saves.worktree.as_ref(),
                    "repo",
                    path,
                )
                .await
                .unwrap()
                .fingerprint(),
                preservation: policy,
            },
        })
        .await
        .unwrap();
    let tasks = TaskService::with_store((*store).clone())
        .unwrap()
        .with_write_access(access);
    let checkout = OperationCheckoutService {
        saves: saves.clone(),
        branches,
    };
    Fixture {
        store,
        saves,
        checkout,
        tasks,
        operation,
        _data: data,
        repository,
    }
}
async fn finished(tasks: &TaskService, id: &str) -> crate::domain::task::TaskSnapshot {
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
pub(crate) async fn preserve(f: &Fixture) -> GitOperation {
    let plan = f.saves.prepare_plan("repo", "backup", "").await.unwrap();
    let task = f
        .saves
        .submit_plan(&f.tasks, &f.operation, plan)
        .await
        .unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
    f.store.operation("op").unwrap().unwrap()
}

#[tokio::test]
async fn operation_preserved_checkout_verifies_branch_and_detached_results_and_keeps_backups() {
    for detached in [false, true] {
        let f = fixture(detached).await;
        let saved = preserve(&f).await;
        let expected = saved.steps.last().unwrap().after_fingerprint.clone();
        let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
        let result = finished(&f.tasks, &task.task_id).await;
        assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
        f.tasks.drain_workers(Duration::from_secs(2)).await;
        let operation = f.store.operation("op").unwrap().unwrap();
        assert_eq!(operation.state.phase, OperationPhase::Restoring);
        assert_eq!(operation.state.status, OperationStatus::Running);
        assert_eq!(operation.steps.len(), 5);
        let execute = operation.steps.last().unwrap();
        assert_eq!(execute.kind, OperationStepKind::Execute);
        assert_eq!(execute.status, OperationStepStatus::Verified);
        assert_eq!(execute.before_fingerprint, expected);
        assert_eq!(execute.task_id.as_deref(), Some(task.task_id.as_str()));
        assert!(execute.after_fingerprint.is_some());
        assert_eq!(operation.backups, saved.backups);
        assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
        assert_eq!(
            f.store
                .operation_owner(&operation.resource_key)
                .unwrap()
                .as_deref(),
            Some("op")
        );
        let path = f.repository.path();
        assert_eq!(
            git(path, &["branch", "--show-current"]),
            if detached { "" } else { "other" }
        );
        assert_eq!(
            Some(git(path, &["rev-parse", "HEAD"])),
            operation.state.result_head_oid
        );
        assert_eq!(std::fs::read_to_string(path.join("a")).unwrap(), "other\n");
        assert!(!path.join("new").exists());
        assert!(f
            .saves
            .commands
            .read_worktree_state(path)
            .await
            .unwrap()
            .dirty_paths
            .is_empty());
        let replay = f
            .checkout
            .submit_preserved(&f.tasks, &operation)
            .await
            .unwrap();
        assert_eq!(
            finished(&f.tasks, &replay.task_id).await.status,
            TaskStatus::Failed
        );
        f.tasks.drain_workers(Duration::from_secs(2)).await;
        assert_eq!(f.store.operation("op").unwrap().unwrap(), operation);
    }
}

#[tokio::test]
async fn operation_preserved_checkout_rejects_incomplete_groups_and_changed_source_before_intent() {
    let f = fixture(false).await;
    let saved = preserve(&f).await;
    for mutate in [0, 1, 2] {
        let mut partial = saved.clone();
        match mutate {
            0 => {
                partial.steps.pop();
            }
            1 => {
                partial.backups.pop();
            }
            _ => partial.steps[1].status = OperationStepStatus::Unknown,
        }
        assert!(saved::completed(&partial).is_err());
    }
    std::fs::write(f.repository.path().join("a"), "external\n").unwrap();
    let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.status, TaskStatus::Failed);
    assert_eq!(
        result.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps, saved.steps);
    assert_eq!(stopped.backups, saved.backups);
    assert_eq!(
        stopped.state.wait_reason,
        Some(OperationWaitReason::ExternalChange)
    );
    assert_eq!(
        git(f.repository.path(), &["branch", "--show-current"]),
        "main"
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "external\n"
    );
}

#[tokio::test]
async fn operation_preserved_checkout_rejects_target_movement_before_intent() {
    let f = fixture(false).await;
    let saved = preserve(&f).await;
    git(
        f.repository.path(),
        &["update-ref", "refs/heads/other", "refs/heads/main"],
    );
    let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(
        result.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps, saved.steps);
    assert_eq!(stopped.backups, saved.backups);
    assert_eq!(
        git(f.repository.path(), &["branch", "--show-current"]),
        "main"
    );
}

#[tokio::test]
async fn operation_preserved_checkout_rejects_a_corrupted_durable_backup_before_intent() {
    let f = fixture(false).await;
    let saved = preserve(&f).await;
    let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE shelves SET patch=?1 WHERE shelf_id=?2",
            rusqlite::params![b"corrupted backup".as_slice(), saved.backups[0].shelf_id],
        )
        .unwrap();
    drop(connection);
    let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(
        result.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.steps, saved.steps);
    assert_eq!(stopped.backups, saved.backups);
    assert!(f
        .store
        .operation_owner(&stopped.resource_key)
        .unwrap()
        .is_some());
    assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
    assert_eq!(
        git(f.repository.path(), &["branch", "--show-current"]),
        "main"
    );
}

#[tokio::test]
async fn operation_preserved_checkout_hook_changes_leave_unknown_intent_without_restoring_or_deleting(
) {
    let f = fixture(false).await;
    let saved = preserve(&f).await;
    let hooks = f.repository.path().join(".git/hooks");
    git(
        f.repository.path(),
        &[
            "config",
            "core.hooksPath",
            &hooks.to_string_lossy().replace('\\', "/"),
        ],
    );
    let hook = hooks.join("post-checkout");
    std::fs::write(&hook, "#!/bin/sh\nprintf 'hook mutation\\n' > a\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let task = f.checkout.submit_preserved(&f.tasks, &saved).await.unwrap();
    let result = finished(&f.tasks, &task.task_id).await;
    assert_eq!(result.failure_code, Some(GitFailureCode::OutcomeUnknown));
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(stopped.state.phase, OperationPhase::Executing);
    assert_eq!(stopped.state.status, OperationStatus::RecoveryRequired);
    assert_eq!(
        stopped.steps.last().unwrap().status,
        OperationStepStatus::Unknown
    );
    assert_eq!(stopped.backups, saved.backups);
    assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
    assert!(f
        .store
        .operation_owner(&stopped.resource_key)
        .unwrap()
        .is_some());
    assert_eq!(
        git(f.repository.path(), &["branch", "--show-current"]),
        "other"
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "hook mutation\n"
    );
}

#[test]
fn operation_checkout_command_modes_are_distinct_and_legacy_records_are_not_guessed() {
    let legacy: OperationCommand =
        serde_json::from_str(r#"{"kind":"checkout","target":"other","targetOid":"oid"}"#).unwrap();
    assert!(matches!(legacy, OperationCommand::Checkout { .. }));
    let branch = preview::ResolvedCheckoutTarget::LocalBranch {
        name: "other".into(),
        oid: "oid".into(),
    }
    .operation_command();
    let detached =
        preview::ResolvedCheckoutTarget::DetachedCommit { oid: "oid".into() }.operation_command();
    assert_ne!(branch, detached);
    assert_ne!(
        serde_json::to_vec(&branch).unwrap(),
        serde_json::to_vec(&detached).unwrap()
    );
    assert_eq!(
        serde_json::from_slice::<OperationCommand>(&serde_json::to_vec(&branch).unwrap()).unwrap(),
        branch
    );
}

#[tokio::test]
async fn operation_preserved_checkout_refuses_ordinary_task_context_without_mutation() {
    let f = fixture(false).await;
    let service = f.checkout.clone();
    let task = f
        .tasks
        .submit(
            None,
            None,
            "unrelated",
            "misroutedCheckout",
            move |context| async move { service.run("op", &context).await.map(|_| None) },
        )
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
    assert_eq!(f.store.operation("op").unwrap().unwrap(), f.operation);
    assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
    assert_eq!(
        git(f.repository.path(), &["branch", "--show-current"]),
        "main"
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("a")).unwrap(),
        "working\n"
    );
}
