use super::*;
use crate::{
    domain::operation::*,
    features::operations::{
        checkout::tests::{fixture_from_repository, fixture_with, preserve, Fixture},
        query::OperationQueryService,
        restore::tests::finished,
    },
    ports::{operations::OperationStorePort, shelves::ShelfStorePort},
};
use std::{path::Path, process::Command, time::Duration};

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
fn request(version: i64) -> OperationActionRequest {
    OperationActionRequest {
        request_id: "start-checkout".into(),
        expected_version: version,
        kind: OperationActionKind::StartPreservedCheckout,
    }
}
fn service(f: &Fixture) -> OperationActionService {
    OperationActionService {
        store: f.store.clone(),
        restore: OperationRestoreService {
            checkout: f.checkout.clone(),
        },
    }
}
pub(super) async fn merge_fixture(detached: bool, policy: PreservationPolicy) -> Fixture {
    let repository = crate::features::operations::preview::tests::repository();
    let path = repository.path();
    let base = (1..=12).map(|i| format!("line{i}\n")).collect::<String>();
    std::fs::write(path.join("a"), &base).unwrap();
    git(path, &["commit", "-qam", "multiline source"]);
    git(path, &["update-ref", "refs/heads/other", "HEAD"]);
    git(path, &["switch", "-q", "other"]);
    std::fs::write(path.join("a"), base.replace("line1\n", "target1\n")).unwrap();
    git(path, &["commit", "-qam", "target"]);
    git(path, &["switch", "-q", "main"]);
    let staged = base.replace("line10\n", "staged10\n");
    std::fs::write(path.join("a"), &staged).unwrap();
    git(path, &["add", "a"]);
    std::fs::write(path.join("a"), staged.replace("line5\n", "working5\n")).unwrap();
    std::fs::write(path.join("new"), "untracked\n").unwrap();
    fixture_from_repository(repository, detached, policy).await
}

#[tokio::test]
async fn initial_checkout_action_owns_save_execute_and_all_restores_without_child_tasks_or_replays()
{
    for (detached, policy) in [
        (false, PreservationPolicy::Restore),
        (true, PreservationPolicy::KeepOnSourceBranch),
    ] {
        let f = merge_fixture(detached, policy).await;
        let actions = service(&f);
        let input = request(f.operation.version);
        let view = OperationQueryService {
            store: f.store.clone(),
        }
        .get(RequestAccess::ReadWrite, "repo", "op")
        .await
        .unwrap();
        assert_eq!(
            view.allowed_actions,
            vec![OperationActionKind::StartPreservedCheckout]
        );
        for access in [RequestAccess::ReadOnly, RequestAccess::ConflictOnly] {
            assert!(matches!(
                actions
                    .submit(&f.tasks, access, "repo", "op", input.clone())
                    .await,
                Err(ActionSubmitError::Forbidden)
            ));
        }
        assert!(matches!(
            actions
                .submit(
                    &f.tasks,
                    RequestAccess::ReadWrite,
                    "other",
                    "op",
                    input.clone()
                )
                .await,
            Err(ActionSubmitError::Store(OperationStoreError::NotFound))
        ));
        assert_eq!(f.store.operation("op").unwrap().unwrap(), f.operation);
        let (a, b) = tokio::join!(
            actions.submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                input.clone()
            ),
            actions.submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                input.clone()
            )
        );
        let a = a.unwrap();
        let b = b.unwrap();
        let task = a.task.as_ref().or(b.task.as_ref()).unwrap();
        if let (Some(a), Some(b)) = (&a.task, &b.task) {
            assert_eq!(a.task_id, b.task_id);
        }
        let result = finished(&f.tasks, &task.task_id).await;
        assert_eq!(result.status, TaskStatus::Succeeded, "{:?}", result.message);
        let done = f.store.operation("op").unwrap().unwrap();
        assert_eq!(done.state.status, OperationStatus::Succeeded);
        assert_eq!(
            done.steps.len(),
            if policy == PreservationPolicy::Restore {
                9
            } else {
                5
            }
        );
        assert!(done
            .steps
            .iter()
            .all(|s| s.task_id.as_deref() == Some(task.task_id.as_str())
                && s.status == OperationStepStatus::Verified));
        assert_eq!(
            done.preservation_plan.as_ref().unwrap().task_id,
            task.task_id
        );
        assert!(f
            .store
            .operation_owner(&done.resource_key)
            .unwrap()
            .is_none());
        assert_eq!(f.store.list_shelf_snapshots("repo").unwrap().len(), 2);
        let path = f.repository.path();
        assert_eq!(
            git(path, &["branch", "--show-current"]),
            if detached { "" } else { "other" }
        );
        if policy == PreservationPolicy::Restore {
            let index = git(path, &["show", ":a"]);
            assert!(index.starts_with("target1\n") && index.contains("staged10\n"));
            assert!(index.contains("line5\n") && !index.contains("working5\n"));
            assert_eq!(
                std::fs::read_to_string(path.join("a")).unwrap(),
                format!("{}\n", index.replace("line5\n", "working5\n"))
            );
            assert_eq!(
                std::fs::read_to_string(path.join("new")).unwrap(),
                "untracked\n"
            );
            assert!(done
                .backups
                .iter()
                .all(|b| b.disposition == BackupDisposition::Restored));
        } else {
            assert_eq!(git(path, &["status", "--porcelain"]), "");
            assert!(done
                .backups
                .iter()
                .all(|b| b.disposition == BackupDisposition::KeptOnSource));
        }
        let duplicate = actions
            .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", input)
            .await
            .unwrap();
        assert_eq!(duplicate.action.status, OperationActionStatus::Succeeded);
        assert_eq!(
            duplicate.action.task_id.as_deref(),
            Some(task.task_id.as_str())
        );
        assert_eq!(f.store.operation("op").unwrap().unwrap(), done);
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn initial_checkout_action_revalidates_before_saving_and_does_not_shelve_safe_carry_over() {
    for mutation in ["source", "target", "branch", "unsupported", "carry"] {
        let f = fixture_with(
            false,
            mutation != "carry",
            PreservationPolicy::Restore,
            false,
        )
        .await;
        let path = f.repository.path();
        match mutation {
            "source" => std::fs::write(path.join("b"), "external\n").unwrap(),
            "target" => {
                git(path, &["update-ref", "refs/heads/other", "refs/heads/main"]);
            }
            "branch" => {
                git(path, &["switch", "-c", "external"]);
            }
            "unsupported" => std::fs::write(path.join("b"), [0, 1, 2]).unwrap(),
            _ => {}
        }
        let index = std::fs::read(path.join(".git/index")).unwrap();
        let refs = git(path, &["show-ref"]);
        let files = ["a", "b", "new"].map(|name| std::fs::read(path.join(name)).unwrap());
        let task = service(&f)
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                request(f.operation.version),
            )
            .await
            .unwrap()
            .task
            .unwrap();
        let result = finished(&f.tasks, &task.task_id).await;
        assert_eq!(
            result.status,
            TaskStatus::Failed,
            "{mutation}: {:?}",
            result.message
        );
        let stopped = f.store.operation("op").unwrap().unwrap();
        assert!(stopped.steps.is_empty() && stopped.backups.is_empty());
        assert!(stopped.preservation_plan.is_none());
        assert_eq!(
            stopped.state.wait_reason,
            Some(if mutation == "unsupported" {
                OperationWaitReason::UnsupportedPreservation
            } else {
                OperationWaitReason::ExternalChange
            })
        );
        assert!(f.store.list_shelf_snapshots("repo").unwrap().is_empty());
        assert_eq!(std::fs::read(path.join(".git/index")).unwrap(), index);
        assert_eq!(git(path, &["show-ref"]), refs);
        assert_eq!(
            ["a", "b", "new"].map(|name| std::fs::read(path.join(name)).unwrap()),
            files
        );
        assert!(f
            .store
            .operation_owner(&stopped.resource_key)
            .unwrap()
            .is_some());
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn initial_checkout_action_stops_on_plan_save_or_cleanup_storage_failure_before_checkout() {
    for checkpoint in ["plan", "save", "clean"] {
        let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
        let path = f.repository.path();
        let connection = rusqlite::Connection::open(f._data.path().join("core.sqlite")).unwrap();
        if checkpoint == "plan" {
            connection.execute_batch("CREATE TRIGGER reject_plan BEFORE INSERT ON git_operation_preservation_plans BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        } else {
            connection.execute_batch(&format!("CREATE TRIGGER reject_confirmation BEFORE UPDATE ON git_operation_steps WHEN json_extract(NEW.step_json, '$.kind')='{checkpoint}' AND json_extract(NEW.step_json, '$.status')='verified' BEGIN SELECT RAISE(ABORT, 'injected'); END;")).unwrap();
        }
        let actions = service(&f);
        let input = request(f.operation.version);
        let task = actions
            .submit(
                &f.tasks,
                RequestAccess::ReadWrite,
                "repo",
                "op",
                input.clone(),
            )
            .await
            .unwrap()
            .task
            .unwrap();
        assert_eq!(
            finished(&f.tasks, &task.task_id).await.status,
            TaskStatus::Failed
        );
        let stopped = f.store.operation("op").unwrap().unwrap();
        assert_eq!(stopped.state.status, OperationStatus::RecoveryRequired);
        assert_eq!(git(path, &["branch", "--show-current"]), "main");
        assert_eq!(
            Some(git(path, &["rev-parse", "HEAD"])),
            stopped.request.source_head_oid
        );
        assert!(stopped
            .steps
            .iter()
            .all(|s| matches!(s.kind, OperationStepKind::Save | OperationStepKind::Clean)));
        if checkpoint == "plan" {
            assert!(stopped.steps.is_empty() && stopped.preservation_plan.is_none());
            assert_eq!(
                std::fs::read_to_string(path.join("a")).unwrap(),
                "working\n"
            );
        } else {
            assert_eq!(
                stopped.steps.len(),
                if checkpoint == "save" { 1 } else { 2 }
            );
            assert_eq!(
                stopped.steps.last().unwrap().status,
                OperationStepStatus::Unknown
            );
            assert_eq!(
                stopped.steps.last().unwrap().kind,
                if checkpoint == "save" {
                    OperationStepKind::Save
                } else {
                    OperationStepKind::Clean
                }
            );
            assert_eq!(
                stopped.backups.len(),
                if checkpoint == "save" { 0 } else { 1 }
            );
            assert!(!f.store.list_shelf_snapshots("repo").unwrap().is_empty());
        }
        assert!(f
            .store
            .operation_owner(&stopped.resource_key)
            .unwrap()
            .is_some());
        assert!(!OperationActionKind::StartPreservedCheckout.allowed(&stopped));
        let duplicate = actions
            .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", input)
            .await
            .unwrap();
        assert_eq!(duplicate.action.status, OperationActionStatus::Failed);
        assert_eq!(
            duplicate.action.task_id.as_deref(),
            Some(task.task_id.as_str())
        );
        assert_eq!(f.store.operation("op").unwrap().unwrap(), stopped);
        let retry = OperationActionRequest {
            request_id: "unsafe-retry".into(),
            expected_version: stopped.version,
            kind: OperationActionKind::StartPreservedCheckout,
        };
        assert!(matches!(
            actions
                .submit(&f.tasks, RequestAccess::ReadWrite, "repo", "op", retry)
                .await,
            Err(ActionSubmitError::Store(
                OperationStoreError::InvalidTransition
            ))
        ));
        assert_eq!(f.store.operation("op").unwrap().unwrap(), stopped);
        f.tasks.drain_workers(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn initial_checkout_action_stops_at_restore_conflict_without_starting_later_groups() {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let task = service(&f)
        .submit(
            &f.tasks,
            RequestAccess::ReadWrite,
            "repo",
            "op",
            request(f.operation.version),
        )
        .await
        .unwrap()
        .task
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.status,
        TaskStatus::WaitingForInput
    );
    let stopped = f.store.operation("op").unwrap().unwrap();
    assert_eq!(
        stopped.state.wait_reason,
        Some(OperationWaitReason::RestoreConflict)
    );
    assert_eq!(stopped.steps.len(), 7);
    assert!(stopped
        .steps
        .iter()
        .all(|s| s.task_id.as_deref() == Some(task.task_id.as_str())));
    assert!(stopped
        .backups
        .iter()
        .all(|b| b.disposition == BackupDisposition::Retained));
    assert!(f
        .store
        .operation_owner(&stopped.resource_key)
        .unwrap()
        .is_some());
    assert!(!f.repository.path().join("new").exists());
    assert_eq!(
        std::fs::read_to_string(f.repository.path().join("b")).unwrap(),
        "base\n"
    );
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn initial_checkout_action_requires_owner_context_and_the_actual_save_producer_for_in_task_checkout(
) {
    let f = fixture_with(false, true, PreservationPolicy::Restore, false).await;
    let restore = service(&f).restore;
    let task = f
        .tasks
        .submit(
            None,
            None,
            "unrelated",
            "misroutedCheckout",
            move |context| async move {
                restore
                    .start_preserved_checkout("op", &context)
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
    assert_eq!(f.store.operation("op").unwrap().unwrap(), f.operation);
    let saved = preserve(&f).await;
    let checkout = f.checkout.clone();
    let task = f
        .tasks
        .submit_operation(&saved, "differentProducer", move |context| async move {
            checkout
                .run_after_preservation("op", &context)
                .await
                .map(|_| None)
        })
        .await
        .unwrap();
    assert_eq!(
        finished(&f.tasks, &task.task_id).await.failure_code,
        Some(GitFailureCode::PreconditionChanged)
    );
    assert_eq!(f.store.operation("op").unwrap().unwrap(), saved);
    f.tasks.drain_workers(Duration::from_secs(2)).await;
}
