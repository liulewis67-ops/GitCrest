//! A restart is simulated by building a second service over the same database and the same
//! folders: nothing the first service held in memory survives, exactly as after closing GitCrest.

use std::{sync::Arc, time::Duration};

use super::{
    ephemeral::{context_id, EphemeralAwareCatalog, EphemeralContexts},
    service::{PipelineService, RunAction},
    service_tests::{
        auto_rule, conflict_on_uat, harness, pushed, wait_for_conflicts, wait_for_terminal, Harness,
    },
    worktree_tests::git,
};
use crate::{
    domain::pipeline::{ExecutionMode, PipelineRepositorySettings, RunStatus, StepState},
    events::publisher::EventBus,
    features::{repositories::RepositoryTargetReader, tasks::TaskService},
    git::command::GitCommandService,
    git::repository::GitRepositoryAdapter,
    ports::{pipelines::PipelineStorePort, repository::RepositoryCatalogPort},
    storage::repository_paths::RepositoryFilesystemAdapter,
};

use super::engine::PushOrigin;

struct Restarted {
    service: PipelineService,
    tasks: TaskService,
    events: EventBus,
    contexts: Arc<EphemeralContexts>,
}

fn restart(harness: &Harness) -> Restarted {
    let contexts = Arc::new(EphemeralContexts::default());
    let catalog: Arc<dyn RepositoryCatalogPort> = Arc::new(EphemeralAwareCatalog::new(
        harness.store.clone(),
        contexts.clone(),
    ));
    let targets = RepositoryTargetReader::new(
        catalog.clone(),
        Arc::new(GitRepositoryAdapter),
        Arc::new(RepositoryFilesystemAdapter),
    )
    .with_ephemeral_contexts(contexts.clone());
    let tasks = TaskService::default();
    let events = EventBus::default();
    let service = PipelineService::new(
        harness.store.clone(),
        catalog,
        contexts.clone(),
        events.clone(),
        harness.fixture.data_dir.clone(),
        tasks.clone(),
        targets,
        GitCommandService::default(),
    );
    Restarted {
        service,
        tasks,
        events,
        contexts,
    }
}

async fn start_waiting_run(harness: &Harness) -> crate::domain::pipeline::PipelineRun {
    conflict_on_uat(harness);
    harness
        .service
        .on_push_succeeded(pushed(harness), PushOrigin::User)
        .await;
    wait_for_conflicts(harness).await
}

async fn wait_for_status(
    harness: &Harness,
    run_id: &str,
    wanted: RunStatus,
) -> crate::domain::pipeline::PipelineRun {
    for _ in 0..300 {
        let run = harness.store.pipeline_run(run_id).unwrap().unwrap();
        if run.status == wanted {
            return run;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the run never reached {wanted:?}");
}

#[tokio::test]
async fn waiting_conflicts_in_a_worktree_are_picked_up_again_after_a_restart() {
    let harness = harness(auto_rule());
    let waiting = start_waiting_run(&harness).await;
    let context = context_id(&waiting.run_id, 0);
    let after = restart(&harness);
    assert_eq!(after.contexts.path(&context), None, "memory is gone");

    after.service.recover_on_startup().await;

    let run = harness
        .store
        .pipeline_run(&waiting.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(run.status, RunStatus::WaitingForConflicts);
    let worktree = after
        .contexts
        .path(&context)
        .expect("context registered again");
    assert!(git(&worktree, &["status", "--porcelain"]).contains("AA feature.txt"));
    // The conflict window finds its waiting task again.
    let mut found = false;
    for _ in 0..100 {
        found = after
            .tasks
            .list()
            .await
            .iter()
            .any(|task| task.repo_id.as_deref() == Some(context.as_str()));
        if found {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(found, "a waiting task exists for the pipeline context");

    std::fs::write(worktree.join("feature.txt"), "resolved\n").unwrap();
    git(&worktree, &["add", "feature.txt"]);
    git(&worktree, &["commit", "-q", "--no-edit"]);
    after
        .service
        .act("repo", &waiting.run_id, RunAction::Resume)
        .await
        .unwrap();
    wait_for_status(&harness, &waiting.run_id, RunStatus::Succeeded).await;
    assert_eq!(
        git(&harness.fixture.remote, &["show", "uat:feature.txt"]),
        "resolved"
    );
}

#[tokio::test]
async fn a_resolved_but_unpushed_merge_is_offered_for_pushing_after_a_restart() {
    let harness = harness(auto_rule());
    let waiting = start_waiting_run(&harness).await;
    let worktree = harness
        .service
        .contexts()
        .path(&context_id(&waiting.run_id, 0))
        .unwrap();
    std::fs::write(worktree.join("feature.txt"), "resolved\n").unwrap();
    git(&worktree, &["add", "feature.txt"]);
    git(&worktree, &["commit", "-q", "--no-edit"]);
    let after = restart(&harness);
    let mut events = after.events.subscribe();

    after.service.recover_on_startup().await;

    let run = harness
        .store
        .pipeline_run(&waiting.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(run.status, RunStatus::Interrupted);
    let announced = std::iter::from_fn(|| events.try_recv().ok())
        .filter(|event| event.event_type == "pipeline.run.updated")
        .last()
        .expect("the run was announced again");
    assert_eq!(announced.payload["status"], "interrupted");
    assert_eq!(announced.payload["recovery"], "resumePush");

    after
        .service
        .act("repo", &waiting.run_id, RunAction::Resume)
        .await
        .unwrap();
    let finished = wait_for_terminal(&harness.store, "repo").await;
    assert_eq!(finished.status, RunStatus::Succeeded);
    assert_eq!(
        git(&harness.fixture.remote, &["show", "uat:feature.txt"]),
        "resolved"
    );
}

#[tokio::test]
async fn a_missing_worktree_fails_the_run_and_other_actions_stay_blocked() {
    let harness = harness(auto_rule());
    let waiting = start_waiting_run(&harness).await;
    let worktree = harness
        .service
        .contexts()
        .path(&context_id(&waiting.run_id, 0))
        .unwrap();
    std::fs::remove_dir_all(&worktree).unwrap();
    let after = restart(&harness);

    after.service.recover_on_startup().await;

    let run = harness
        .store
        .pipeline_run(&waiting.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(run.steps[0].state, StepState::Failed);
    assert!(run.steps[0].message.as_deref().unwrap().contains("lost"));
    assert_eq!(run.steps[1].state, StepState::Skipped);
    // The registration of the vanished worktree was pruned.
    let worktrees = git(
        &harness.fixture.repository,
        &["worktree", "list", "--porcelain"],
    );
    assert_eq!(worktrees.matches("worktree ").count(), 1, "{worktrees}");
}

#[tokio::test]
async fn folders_of_unknown_runs_are_swept_but_unfinished_runs_keep_theirs() {
    let harness = harness(auto_rule());
    let waiting = start_waiting_run(&harness).await;
    let orphan = harness.fixture.data_dir.join("pipelines/run_orphan/0");
    std::fs::create_dir_all(&orphan).unwrap();
    let after = restart(&harness);

    after.service.recover_on_startup().await;

    assert!(!harness
        .fixture
        .data_dir
        .join("pipelines/run_orphan")
        .exists());
    assert!(harness
        .fixture
        .data_dir
        .join("pipelines")
        .join(&waiting.run_id)
        .exists());
}

fn use_in_place(harness: &Harness) {
    harness
        .store
        .set_pipeline_repository_settings(
            "repo",
            PipelineRepositorySettings {
                execution_mode: Some(ExecutionMode::SwitchInPlace),
                in_place_dirty_policy: None,
            },
        )
        .unwrap();
}

#[tokio::test]
async fn in_place_conflicts_resume_and_a_left_behind_target_can_return_to_the_source() {
    let harness = harness(auto_rule());
    use_in_place(&harness);
    let waiting = start_waiting_run(&harness).await;
    let repository = &harness.fixture.repository;
    assert_eq!(
        git(repository, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "uat"
    );

    // A restart while the merge waits: the normal conflict flow is back.
    let after = restart(&harness);
    after.service.recover_on_startup().await;
    assert_eq!(
        harness
            .store
            .pipeline_run(&waiting.run_id)
            .unwrap()
            .unwrap()
            .status,
        RunStatus::WaitingForConflicts
    );

    // The merge was aborted by hand before the next restart: the user is left on the target.
    git(repository, &["merge", "--abort"]);
    let again = restart(&harness);
    again.service.recover_on_startup().await;
    let run = harness
        .store
        .pipeline_run(&waiting.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(run.status, RunStatus::Interrupted);
    assert_eq!(
        git(repository, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "uat"
    );

    again
        .service
        .act("repo", &waiting.run_id, RunAction::ReturnToSource)
        .await
        .unwrap();

    let run = harness
        .store
        .pipeline_run(&waiting.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(run.status, RunStatus::Cancelled);
    assert_eq!(
        git(repository, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feature/1"
    );
    assert_eq!(
        std::fs::read_to_string(repository.join("base.txt")).unwrap(),
        "base\nlocal edit\n"
    );
    assert!(repository.join("scratch.txt").exists());
    assert_eq!(git(repository, &["stash", "list"]), "");
}

#[tokio::test]
async fn staying_on_the_target_keeps_the_shelf_in_the_stash_list() {
    let harness = harness(auto_rule());
    use_in_place(&harness);
    let waiting = start_waiting_run(&harness).await;
    let repository = &harness.fixture.repository;
    git(repository, &["merge", "--abort"]);
    let after = restart(&harness);
    after.service.recover_on_startup().await;

    after
        .service
        .act("repo", &waiting.run_id, RunAction::Discard)
        .await
        .unwrap();

    let run = harness
        .store
        .pipeline_run(&waiting.run_id)
        .unwrap()
        .unwrap();
    assert_eq!(run.status, RunStatus::Cancelled);
    assert_eq!(
        git(repository, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "uat"
    );
    assert!(
        git(repository, &["stash", "list"]).contains(&format!("gitcrest-pipeline-{}", run.run_id))
    );
}

#[tokio::test]
async fn a_shelf_that_was_never_restored_stays_visible_after_a_restart() {
    let harness = harness(auto_rule());
    use_in_place(&harness);
    let waiting = start_waiting_run(&harness).await;
    let repository = &harness.fixture.repository;
    git(repository, &["merge", "--abort"]);
    let after = restart(&harness);
    after.service.recover_on_startup().await;
    after
        .service
        .act("repo", &waiting.run_id, RunAction::Discard)
        .await
        .unwrap();

    let shown = |service: &PipelineService| {
        serde_json::to_value(service.run("repo", &waiting.run_id).unwrap()).unwrap()["shelfPending"]
            .clone()
    };
    let again = restart(&harness);
    again.service.recover_on_startup().await;
    assert_eq!(shown(&again.service), true);

    // Once the user restores the changes themselves, nothing is pending any more.
    git(repository, &["stash", "pop", "-q"]);
    let last = restart(&harness);
    last.service.recover_on_startup().await;
    assert_eq!(shown(&last.service), false);
}

#[tokio::test]
async fn a_shelf_left_behind_is_flagged_as_soon_as_the_run_ends() {
    let harness = harness(auto_rule());
    use_in_place(&harness);
    let waiting = start_waiting_run(&harness).await;
    git(&harness.fixture.repository, &["merge", "--abort"]);
    let after = restart(&harness);
    after.service.recover_on_startup().await;

    after
        .service
        .act("repo", &waiting.run_id, RunAction::Discard)
        .await
        .unwrap();

    let mut flagged = false;
    for _ in 0..100 {
        let dto =
            serde_json::to_value(after.service.run("repo", &waiting.run_id).unwrap()).unwrap();
        flagged = dto["shelfPending"] == true;
        if flagged {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(flagged, "no restart was needed to see the leftover shelf");
}
