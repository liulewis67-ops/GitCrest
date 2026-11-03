use std::{sync::Arc, time::Duration};

use super::{
    engine::PushOrigin,
    ephemeral::{EphemeralAwareCatalog, EphemeralContexts},
    service::{PipelineService, PipelineServiceError, PushedBranch, RunAction, StartRun},
    worktree_tests::{fixture, git, Fixture},
};
use crate::{
    domain::pipeline::{
        tests::rule, Confirmation, PipelineRule, PipelineRun, RunStatus, StepState,
    },
    events::publisher::EventBus,
    features::{repositories::RepositoryTargetReader, tasks::TaskService},
    git::command::GitCommandService,
    git::repository::GitRepositoryAdapter,
    ports::pipelines::PipelineStorePort,
    ports::repository::RepositoryCatalogPort,
    storage::repository_paths::RepositoryFilesystemAdapter,
    storage::RepositoryStore,
};

pub(super) struct Harness {
    pub(super) fixture: Fixture,
    pub(super) store: Arc<RepositoryStore>,
    pub(super) service: PipelineService,
    pub(super) events: EventBus,
    pub(super) tasks: TaskService,
}

pub(super) fn harness(rule: PipelineRule) -> Harness {
    let fixture = fixture();
    let store = Arc::new(RepositoryStore::default());
    store.insert_test_repository_at("repo", &fixture.repository);
    store.replace_pipeline_rules("repo", &[rule]).unwrap();
    let events = EventBus::default();
    let contexts = Arc::new(EphemeralContexts::default());
    let catalog: Arc<dyn RepositoryCatalogPort> =
        Arc::new(EphemeralAwareCatalog::new(store.clone(), contexts.clone()));
    let targets = RepositoryTargetReader::new(
        catalog.clone(),
        Arc::new(GitRepositoryAdapter),
        Arc::new(RepositoryFilesystemAdapter),
    )
    .with_ephemeral_contexts(contexts.clone());
    let tasks = TaskService::default();
    let service = PipelineService::new(
        store.clone(),
        catalog,
        contexts,
        events.clone(),
        fixture.data_dir.clone(),
        tasks.clone(),
        targets,
        GitCommandService::default(),
    );
    Harness {
        fixture,
        store,
        service,
        events,
        tasks,
    }
}

pub(super) fn auto_rule() -> PipelineRule {
    let mut rule = rule();
    rule.confirmation = Confirmation::Auto;
    rule
}

pub(super) fn pushed(harness: &Harness) -> PushedBranch {
    PushedBranch {
        repo_id: "repo".into(),
        branch: "feature/1".into(),
        oid: harness.fixture.source_oid.clone(),
    }
}

pub(super) async fn wait_for_terminal(store: &RepositoryStore, repo_id: &str) -> PipelineRun {
    for _ in 0..300 {
        if let Some(run) = store
            .list_pipeline_runs(repo_id, 1)
            .unwrap()
            .into_iter()
            .next()
        {
            if run.status.is_terminal() {
                return run;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the pipeline run did not finish");
}

#[tokio::test]
async fn a_user_push_runs_matching_rules_in_the_background_and_publishes_updates() {
    let harness = harness(auto_rule());
    let mut events = harness.events.subscribe();

    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::User)
        .await;
    let run = wait_for_terminal(&harness.store, "repo").await;

    assert_eq!(run.status, RunStatus::Succeeded);
    for target in ["uat", "dev"] {
        let subject = git(
            &harness.fixture.remote,
            &["log", "-1", "--format=%s", target],
        );
        assert_eq!(subject, format!("Merge branch 'feature/1' into {target}"));
    }
    let mut updates = 0;
    while let Ok(event) = events.try_recv() {
        if event.event_type == "pipeline.run.updated" {
            updates += 1;
            assert_eq!(event.repo_id.as_deref(), Some("repo"));
            assert_eq!(event.payload["sourceBranch"], "feature/1");
        }
    }
    assert!(updates >= 4, "{updates} run updates");
}

#[tokio::test]
async fn pipeline_origin_pushes_and_non_matching_branches_start_nothing() {
    let harness = harness(auto_rule());
    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::Pipeline)
        .await;
    let mut other = pushed(&harness);
    other.branch = "unrelated".into();
    harness
        .service
        .on_push_succeeded(other, PushOrigin::User)
        .await;
    assert!(harness
        .store
        .list_pipeline_runs("repo", 10)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn rules_that_ask_announce_a_pending_run_and_confirm_for_a_subset_of_targets() {
    let harness = harness(rule());
    let mut events = harness.events.subscribe();

    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::User)
        .await;

    let pending = harness
        .store
        .list_pipeline_runs("repo", 1)
        .unwrap()
        .remove(0);
    assert_eq!(pending.status, RunStatus::PendingConfirmation);
    let mut announced = None;
    while let Ok(event) = events.try_recv() {
        if event.event_type == "pipeline.trigger.pending" {
            announced = Some(event.payload);
        }
    }
    let announced = announced.expect("pipeline.trigger.pending was published");
    assert_eq!(announced["runId"], pending.run_id);
    assert_eq!(announced["targets"], serde_json::json!(["uat", "dev"]));

    let invalid = harness
        .service
        .start_run(
            "repo",
            StartRun::Confirm {
                run_id: pending.run_id.clone(),
                targets: Some(vec!["nope".into()]),
            },
        )
        .await;
    assert!(matches!(invalid, Err(PipelineServiceError::Invalid(_))));
    assert!(matches!(
        harness
            .service
            .start_run(
                "other-repo",
                StartRun::Confirm {
                    run_id: pending.run_id.clone(),
                    targets: None
                }
            )
            .await,
        Err(PipelineServiceError::RunNotFound)
    ));

    let started = harness
        .service
        .start_run(
            "repo",
            StartRun::Confirm {
                run_id: pending.run_id.clone(),
                targets: Some(vec!["dev".into()]),
            },
        )
        .await
        .unwrap();
    let _ = started;
    let run = wait_for_terminal(&harness.store, "repo").await;

    assert_eq!(run.status, RunStatus::PartiallySucceeded);
    assert_eq!(run.steps[0].state, StepState::Skipped);
    assert_eq!(run.steps[0].message.as_deref(), Some("Not selected"));
    assert_eq!(run.steps[1].state, StepState::Done);
    let uat_subject = git(
        &harness.fixture.remote,
        &["log", "-1", "--format=%s", "uat"],
    );
    assert_eq!(uat_subject, "base");
}

#[tokio::test]
async fn manual_runs_validate_their_input_and_use_the_given_commit() {
    let harness = harness(auto_rule());
    let manual = |rule_id: &str, oid: &str| StartRun::Manual {
        rule_id: rule_id.into(),
        source_branch: "feature/1".into(),
        source_oid: oid.into(),
        targets: None,
        execution_mode: None,
    };

    assert_eq!(
        harness
            .service
            .start_run("repo", manual("missing", &harness.fixture.source_oid))
            .await
            .err(),
        Some(PipelineServiceError::RuleNotFound)
    );
    assert!(matches!(
        harness
            .service
            .start_run("repo", manual("r_01", "abc"))
            .await,
        Err(PipelineServiceError::Invalid(_))
    ));

    let run = harness
        .service
        .start_run("repo", manual("r_01", &harness.fixture.source_oid))
        .await
        .unwrap();
    let finished = wait_for_terminal(&harness.store, "repo").await;
    assert_eq!(finished.run_id, run_id(&run));
    assert_eq!(finished.status, RunStatus::Succeeded);
}

fn run_id(dto: &super::service::PipelineRunDto) -> String {
    serde_json::to_value(dto).unwrap()["runId"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn actions_require_the_matching_run_state() {
    let harness = harness(auto_rule());
    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::User)
        .await;
    let run = wait_for_terminal(&harness.store, "repo").await;

    for action in [RunAction::Resume, RunAction::SkipTarget, RunAction::Stop] {
        assert!(matches!(
            harness.service.act("repo", &run.run_id, action).await,
            Err(PipelineServiceError::Conflict(_))
        ));
    }
    assert_eq!(
        harness
            .service
            .act("repo", "missing", RunAction::Stop)
            .await
            .err(),
        Some(PipelineServiceError::RunNotFound)
    );
    assert_eq!(harness.service.list_runs("repo", 10).unwrap().len(), 1);
    assert!(harness.service.run("repo", &run.run_id).is_ok());
    assert_eq!(
        harness.service.run("elsewhere", &run.run_id).err(),
        Some(PipelineServiceError::RunNotFound)
    );
}

#[tokio::test]
async fn resume_waits_for_the_worktree_conflicts_to_be_resolved() {
    use super::worktree_tests::commit_file;
    let harness = harness(auto_rule());
    let repository = &harness.fixture.repository;
    git(repository, &["stash", "-u", "-q"]);
    git(repository, &["checkout", "-q", "uat"]);
    commit_file(repository, "feature.txt", "uat version\n", "uat edit");
    git(repository, &["push", "-q", "origin", "uat"]);
    git(repository, &["checkout", "-q", "feature/1"]);
    git(repository, &["stash", "pop", "-q"]);

    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::User)
        .await;
    let mut waiting = None;
    for _ in 0..300 {
        let run = harness
            .store
            .list_pipeline_runs("repo", 1)
            .unwrap()
            .remove(0);
        if run.status == RunStatus::WaitingForConflicts {
            waiting = Some(run);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let waiting = waiting.expect("the run waits for conflicts");
    let context = waiting.steps[0].ephemeral_repo_id.clone().unwrap();
    let worktree = harness.service.contexts().path(&context).unwrap();

    assert!(matches!(
        harness
            .service
            .act("repo", &waiting.run_id, RunAction::Resume)
            .await,
        Err(PipelineServiceError::Conflict(message)) if message.contains("not resolved")
    ));

    std::fs::write(worktree.join("feature.txt"), "resolved\n").unwrap();
    git(&worktree, &["add", "feature.txt"]);
    git(&worktree, &["commit", "-q", "--no-edit"]);
    harness
        .service
        .act("repo", &waiting.run_id, RunAction::Resume)
        .await
        .unwrap();
    let run = wait_for_terminal(&harness.store, "repo").await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(
        git(&harness.fixture.remote, &["show", "uat:feature.txt"]),
        "resolved"
    );
}

pub(super) async fn wait_for_conflicts(harness: &Harness) -> PipelineRun {
    for _ in 0..300 {
        let run = harness
            .store
            .list_pipeline_runs("repo", 1)
            .unwrap()
            .remove(0);
        if run.status == RunStatus::WaitingForConflicts {
            return run;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the run never waited for conflicts");
}

pub(super) fn conflict_on_uat(harness: &Harness) {
    use super::worktree_tests::commit_file;
    let repository = &harness.fixture.repository;
    git(repository, &["stash", "-u", "-q"]);
    git(repository, &["checkout", "-q", "uat"]);
    commit_file(repository, "feature.txt", "uat version\n", "uat edit");
    git(repository, &["push", "-q", "origin", "uat"]);
    git(repository, &["checkout", "-q", "feature/1"]);
    git(repository, &["stash", "pop", "-q"]);
}

#[tokio::test]
async fn a_continued_recovery_on_the_pipeline_context_resumes_the_run() {
    use super::service::RecoveryOutcome;
    let harness = harness(auto_rule());
    conflict_on_uat(&harness);
    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::User)
        .await;
    let waiting = wait_for_conflicts(&harness).await;
    let context = waiting.steps[0].ephemeral_repo_id.clone().unwrap();
    let worktree = harness.service.contexts().path(&context).unwrap();

    // Recoveries on unrelated contexts change nothing.
    harness
        .service
        .on_workflow_recovered("some-other-repo", RecoveryOutcome::Continued)
        .await;
    assert_eq!(
        harness
            .store
            .pipeline_run(&waiting.run_id)
            .unwrap()
            .unwrap()
            .status,
        RunStatus::WaitingForConflicts
    );

    std::fs::write(worktree.join("feature.txt"), "resolved\n").unwrap();
    git(&worktree, &["add", "feature.txt"]);
    git(&worktree, &["commit", "-q", "--no-edit"]);
    harness
        .service
        .on_workflow_recovered(&context, RecoveryOutcome::Continued)
        .await;

    let run = wait_for_terminal(&harness.store, "repo").await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(
        git(&harness.fixture.remote, &["show", "uat:feature.txt"]),
        "resolved"
    );
}

#[tokio::test]
async fn an_aborted_recovery_asks_the_user_and_skipping_then_finishes_the_run() {
    use super::service::RecoveryOutcome;
    let harness = harness(auto_rule());
    conflict_on_uat(&harness);
    let mut events = harness.events.subscribe();
    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::User)
        .await;
    let waiting = wait_for_conflicts(&harness).await;
    let context = waiting.steps[0].ephemeral_repo_id.clone().unwrap();
    let worktree = harness.service.contexts().path(&context).unwrap();

    // The conflict window aborted the merge inside the pipeline worktree.
    git(&worktree, &["merge", "--abort"]);
    harness
        .service
        .on_workflow_recovered(&context, RecoveryOutcome::Aborted)
        .await;

    let mut asked = None;
    while let Ok(event) = events.try_recv() {
        if event.event_type == "pipeline.conflict.aborted" {
            asked = Some(event.payload);
        }
    }
    let asked = asked.expect("pipeline.conflict.aborted was published");
    assert_eq!(asked["runId"], waiting.run_id);
    assert_eq!(asked["targetBranch"], "uat");
    assert_eq!(
        harness
            .store
            .pipeline_run(&waiting.run_id)
            .unwrap()
            .unwrap()
            .status,
        RunStatus::WaitingForConflicts
    );

    harness
        .service
        .act("repo", &waiting.run_id, RunAction::SkipTarget)
        .await
        .unwrap();
    let run = wait_for_terminal(&harness.store, "repo").await;
    assert_eq!(run.status, RunStatus::PartiallySucceeded);
    assert_eq!(run.steps[0].state, StepState::Skipped);
    assert_eq!(
        run.steps[0].message.as_deref(),
        Some("Skipped after conflicts")
    );
}

async fn waiting_task_for(
    harness: &Harness,
    context: &str,
) -> Option<crate::features::tasks::TaskSnapshot> {
    for _ in 0..100 {
        let found = harness
            .tasks
            .list()
            .await
            .into_iter()
            .find(|task| task.repo_id.as_deref() == Some(context));
        if found.is_some() {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

#[tokio::test]
async fn a_conflicting_step_is_mirrored_by_a_waiting_task_that_ends_with_the_step() {
    use crate::domain::task::TaskStatus;
    let harness = harness(auto_rule());
    conflict_on_uat(&harness);
    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::User)
        .await;
    let waiting = wait_for_conflicts(&harness).await;
    let context = waiting.steps[0].ephemeral_repo_id.clone().unwrap();

    let task = waiting_task_for(&harness, &context)
        .await
        .expect("a waiting task exists for the pipeline context");
    assert_eq!(task.operation, "merge");
    assert_eq!(task.target_path.as_deref(), Some("uat · pipeline worktree"));
    assert!(context.starts_with("repo_") && context.len() == 69);
    assert_eq!(task.status, TaskStatus::WaitingForInput);

    harness
        .service
        .act("repo", &waiting.run_id, RunAction::SkipTarget)
        .await
        .unwrap();
    let mut status = TaskStatus::WaitingForInput;
    for _ in 0..100 {
        status = harness.tasks.get(&task.task_id).await.unwrap().status;
        if status != TaskStatus::WaitingForInput {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(status, TaskStatus::Cancelled);
}

#[tokio::test]
async fn a_manual_run_can_use_another_execution_mode_for_that_run_only() {
    use crate::domain::pipeline::ExecutionMode;
    let harness = harness(auto_rule());
    let started = harness
        .service
        .start_run(
            "repo",
            StartRun::Manual {
                rule_id: "r_01".into(),
                source_branch: "feature/1".into(),
                source_oid: harness.fixture.source_oid.clone(),
                targets: None,
                execution_mode: Some(ExecutionMode::SwitchInPlace),
            },
        )
        .await
        .unwrap();
    let dto = serde_json::to_value(&started).unwrap();
    assert_eq!(dto["executionMode"], "switchInPlace");

    let finished = wait_for_terminal(&harness.store, "repo").await;
    assert_eq!(finished.status, RunStatus::Succeeded);
    assert_eq!(finished.execution_mode, ExecutionMode::SwitchInPlace);
    // The repository setting did not change.
    let repository = harness.store.pipeline_repository_settings("repo").unwrap();
    assert_eq!(repository.execution_mode, None);
    assert_eq!(
        git(
            &harness.fixture.repository,
            &["rev-parse", "--abbrev-ref", "HEAD"]
        ),
        "feature/1"
    );
}

#[tokio::test]
async fn a_worktree_that_cannot_be_created_fails_the_step_without_falling_back_to_in_place() {
    let fixture = fixture();
    // A file where the pipeline folder should go makes creating the worktree folder fail.
    std::fs::create_dir_all(&fixture.data_dir).unwrap();
    std::fs::write(fixture.data_dir.join("pipelines"), "not a folder").unwrap();
    let store = Arc::new(RepositoryStore::default());
    store.insert_test_repository_at("repo", &fixture.repository);
    store
        .replace_pipeline_rules("repo", &[auto_rule()])
        .unwrap();
    let contexts = Arc::new(EphemeralContexts::default());
    let catalog: Arc<dyn RepositoryCatalogPort> =
        Arc::new(EphemeralAwareCatalog::new(store.clone(), contexts.clone()));
    let targets = RepositoryTargetReader::new(
        catalog.clone(),
        Arc::new(GitRepositoryAdapter),
        Arc::new(RepositoryFilesystemAdapter),
    )
    .with_ephemeral_contexts(contexts.clone());
    let service = PipelineService::new(
        store.clone(),
        catalog,
        contexts,
        EventBus::default(),
        fixture.data_dir.clone(),
        TaskService::default(),
        targets,
        GitCommandService::default(),
    );

    service
        .on_push_succeeded(
            PushedBranch {
                repo_id: "repo".into(),
                branch: "feature/1".into(),
                oid: fixture.source_oid.clone(),
            },
            PushOrigin::User,
        )
        .await;
    let run = wait_for_terminal(&store, "repo").await;

    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(
        run.execution_mode,
        crate::domain::pipeline::ExecutionMode::TemporaryWorktree
    );
    let dto = serde_json::to_value(service.run("repo", &run.run_id).unwrap()).unwrap();
    assert_eq!(dto["steps"][0]["workspaceFailed"], true);
    assert_eq!(dto["steps"][1]["workspaceFailed"], false);
    assert!(dto["steps"][0]["message"]
        .as_str()
        .unwrap()
        .starts_with("Pipeline worktree unavailable"));
    // Nothing in the user's tree changed and no other mode was tried.
    assert_eq!(
        git(&fixture.repository, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feature/1"
    );
    assert_eq!(git(&fixture.repository, &["stash", "list"]), "");
}

#[tokio::test]
async fn a_running_in_place_run_holds_the_repository_against_new_tasks() {
    use crate::domain::pipeline::{
        tests::{run, step},
        ExecutionMode,
    };
    use crate::execution::TaskFailure;
    use crate::features::tasks::TaskSubmitError;
    let harness = harness(auto_rule());
    let mut held = run(vec![step(0, StepState::Merging)]);
    held.repo_id = "repo".into();
    held.execution_mode = ExecutionMode::SwitchInPlace;
    held.status = RunStatus::Running;
    harness.store.insert_pipeline_run(&held).unwrap();
    let submit = |repo: &'static str| {
        let tasks = harness.tasks.clone();
        async move {
            tasks
                .submit(Some(repo.into()), None, repo, "push", |_| async {
                    Ok::<Option<String>, TaskFailure>(None)
                })
                .await
        }
    };

    assert!(matches!(
        submit("repo").await,
        Err(TaskSubmitError::RepositoryHeld)
    ));
    assert!(submit("other").await.is_ok());

    harness
        .store
        .update_pipeline_run("run", RunStatus::WaitingForConflicts, None)
        .unwrap();
    assert!(submit("repo").await.is_ok());
}

fn hook_command(windows: &str, unix: &str) -> crate::domain::pipeline::HookCommand {
    let (program, args) = if cfg!(windows) {
        ("cmd.exe", vec!["/d", "/s", "/c", windows])
    } else {
        ("sh", vec!["-c", unix])
    };
    crate::domain::pipeline::HookCommand {
        program: program.into(),
        args: args.into_iter().map(String::from).collect(),
        timeout_seconds: 10,
    }
}

#[tokio::test]
async fn commit_hooks_are_isolated_from_push_and_commands_receive_context_in_order() {
    use crate::domain::pipeline::PipelineTrigger;
    let mut rule = auto_rule();
    rule.trigger = PipelineTrigger::AfterCommit {
        branch_pattern: "feature/*".into(),
    };
    rule.targets.clear();
    rule.commands = vec![
        hook_command(
            "echo %GITCREST_EVENT%:%GITCREST_BRANCH%:%GITCREST_COMMIT%>hook.txt",
            r#"printf '%s:%s:%s' "$GITCREST_EVENT" "$GITCREST_BRANCH" "$GITCREST_COMMIT" > hook.txt"#,
        ),
        hook_command("echo second>>hook.txt", "printf '\nsecond' >> hook.txt"),
    ];
    let harness = harness(rule);
    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::User)
        .await;
    assert!(harness
        .store
        .list_pipeline_runs("repo", 10)
        .unwrap()
        .is_empty());
    harness.service.on_commit_succeeded(pushed(&harness)).await;
    let run = wait_for_terminal(&harness.store, "repo").await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(run.steps.len(), 2);
    let text = std::fs::read_to_string(harness.fixture.repository.join("hook.txt")).unwrap();
    assert!(text.contains(&format!(
        "afterCommit:feature/1:{}",
        harness.fixture.source_oid
    )));
    assert!(text.trim_end().ends_with("second"));
    assert_eq!(
        git(&harness.fixture.repository, &["branch", "--show-current"]),
        "feature/1"
    );
}

#[tokio::test]
async fn a_failed_hook_command_stops_following_commands() {
    let mut rule = auto_rule();
    rule.targets.clear();
    rule.commands = vec![
        hook_command("exit /b 7", "exit 7"),
        hook_command("echo bad>unexpected.txt", "touch unexpected.txt"),
    ];
    let harness = harness(rule);
    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::User)
        .await;
    let run = wait_for_terminal(&harness.store, "repo").await;
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(run.steps[0].state, StepState::Failed);
    assert!(run.steps[0].message.as_deref().unwrap().contains('7'));
    assert_eq!(run.steps[1].state, StepState::Skipped);
    assert!(!harness.fixture.repository.join("unexpected.txt").exists());
}

#[tokio::test]
async fn a_hook_timeout_is_recorded_as_failure() {
    let mut rule = auto_rule();
    rule.targets.clear();
    let mut command = hook_command("ping -n 10 127.0.0.1 > nul", "sleep 10");
    command.timeout_seconds = 1;
    rule.commands = vec![command];
    let harness = harness(rule);
    harness
        .service
        .on_push_succeeded(pushed(&harness), PushOrigin::User)
        .await;
    let run = wait_for_terminal(&harness.store, "repo").await;
    assert_eq!(run.status, RunStatus::Failed);
    assert!(run.steps[0]
        .message
        .as_deref()
        .unwrap()
        .contains("timed out"));
}

#[tokio::test]
async fn commit_events_do_not_run_legacy_push_rules() {
    let harness = harness(auto_rule());
    harness.service.on_commit_succeeded(pushed(&harness)).await;
    assert!(harness
        .store
        .list_pipeline_runs("repo", 10)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_custom_command_run_holds_the_repository_even_in_worktree_mode() {
    use crate::domain::pipeline::{
        tests::{run, step},
        ExecutionMode,
    };
    use crate::execution::TaskFailure;
    use crate::features::tasks::TaskSubmitError;
    let harness = harness(auto_rule());
    let mut held = run(vec![step(0, StepState::Merging)]);
    held.repo_id = "repo".into();
    held.execution_mode = ExecutionMode::TemporaryWorktree;
    held.rule.commands = vec![hook_command("exit /b 0", "exit 0")];
    held.status = RunStatus::Running;
    harness.store.insert_pipeline_run(&held).unwrap();
    let submit = |repo: &'static str| {
        let tasks = harness.tasks.clone();
        async move {
            tasks
                .submit(Some(repo.into()), None, repo, "push", |_| async {
                    Ok::<Option<String>, TaskFailure>(None)
                })
                .await
        }
    };

    assert!(matches!(
        submit("repo").await,
        Err(TaskSubmitError::RepositoryHeld)
    ));
    assert!(submit("other").await.is_ok());

    harness
        .store
        .update_pipeline_run("run", RunStatus::WaitingForConflicts, None)
        .unwrap();
    assert!(submit("repo").await.is_ok());
}
