use std::{sync::Arc, time::Duration};

use super::{
    engine::PushOrigin,
    ephemeral::EphemeralContexts,
    service::{PipelineService, PipelineServiceError, PushedBranch, RunAction, StartRun},
    worktree_tests::{fixture, git, Fixture},
};
use crate::{
    domain::pipeline::{
        tests::rule, Confirmation, PipelineRule, PipelineRun, RunStatus, StepState,
    },
    events::publisher::EventBus,
    ports::pipelines::PipelineStorePort,
    storage::RepositoryStore,
};

struct Harness {
    fixture: Fixture,
    store: Arc<RepositoryStore>,
    service: PipelineService,
    events: EventBus,
}

fn harness(rule: PipelineRule) -> Harness {
    let fixture = fixture();
    let store = Arc::new(RepositoryStore::default());
    store.insert_test_repository_at("repo", &fixture.repository);
    store.replace_pipeline_rules("repo", &[rule]).unwrap();
    let events = EventBus::default();
    let service = PipelineService::new(
        store.clone(),
        store.clone(),
        Arc::new(EphemeralContexts::default()),
        events.clone(),
        fixture.data_dir.clone(),
    );
    Harness {
        fixture,
        store,
        service,
        events,
    }
}

fn auto_rule() -> PipelineRule {
    let mut rule = rule();
    rule.confirmation = Confirmation::Auto;
    rule
}

fn pushed(harness: &Harness) -> PushedBranch {
    PushedBranch {
        repo_id: "repo".into(),
        branch: "feature/1".into(),
        oid: harness.fixture.source_oid.clone(),
    }
}

async fn wait_for_terminal(store: &RepositoryStore, repo_id: &str) -> PipelineRun {
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
