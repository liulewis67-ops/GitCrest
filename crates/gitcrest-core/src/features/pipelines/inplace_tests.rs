use std::sync::Arc;

use super::{
    engine::{NewRun, PipelineEngine, ResumeAction},
    inplace::InPlaceWorkspace,
    worktree_tests::{commit_file, fixture, git, Fixture},
};
use crate::{
    domain::pipeline::{
        tests::rule, Confirmation, ExecutionMode, InPlaceDirtyPolicy, PipelineRule, RunStatus,
        StepState,
    },
    ports::pipelines::PipelineStorePort,
    storage::RepositoryStore,
};

type Engine = PipelineEngine<RepositoryStore, InPlaceWorkspace>;

fn engine(fixture: &Fixture, policy: InPlaceDirtyPolicy) -> (Engine, Arc<RepositoryStore>) {
    let store = Arc::new(RepositoryStore::default());
    store.insert_test_repository("repo");
    let repository = fixture.repository.clone();
    let workspace = InPlaceWorkspace::new(
        Arc::new(move |_| Some(repository.clone())),
        Arc::new(move |_| policy),
    );
    (
        PipelineEngine::new(store.clone(), Arc::new(workspace)),
        store,
    )
}

fn auto_rule() -> PipelineRule {
    let mut rule = rule();
    rule.confirmation = Confirmation::Auto;
    rule
}

fn new_run(fixture: &Fixture) -> NewRun {
    NewRun {
        run_id: "run1".into(),
        repo_id: "repo".into(),
        rule: auto_rule(),
        source_branch: "feature/1".into(),
        source_oid: fixture.source_oid.clone(),
        execution_mode: ExecutionMode::SwitchInPlace,
        hold: false,
        now_ms: 1,
    }
}

fn assert_back_on_source_with_changes(fixture: &Fixture) {
    assert_eq!(
        git(&fixture.repository, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feature/1"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.repository.join("base.txt")).unwrap(),
        "base\nlocal edit\n"
    );
    assert!(fixture.repository.join("scratch.txt").exists());
    assert_eq!(git(&fixture.repository, &["stash", "list"]), "");
}

#[tokio::test]
async fn dirty_work_is_shelved_for_the_run_and_restored_on_the_source_branch() {
    let fixture = fixture();
    let (engine, store) = engine(&fixture, InPlaceDirtyPolicy::Shelve);
    engine.create_run(new_run(&fixture)).await.unwrap();

    assert_eq!(engine.drive("run1").await, Ok(RunStatus::Succeeded));

    for target in ["uat", "dev"] {
        let subject = git(&fixture.remote, &["log", "-1", "--format=%s", target]);
        assert_eq!(subject, format!("Merge branch 'feature/1' into {target}"));
        assert_eq!(
            git(
                &fixture.repository,
                &["rev-parse", &format!("refs/heads/{target}")]
            ),
            git(&fixture.remote, &["rev-parse", target])
        );
    }
    assert_back_on_source_with_changes(&fixture);
    let stored = store.pipeline_run("run1").unwrap().unwrap();
    assert!(stored.shelf_id.is_some());
    assert!(stored.steps.iter().all(|s| s.state == StepState::Done));
}

#[tokio::test]
async fn a_clean_tree_needs_no_shelf() {
    let fixture = fixture();
    git(&fixture.repository, &["checkout", "--", "base.txt"]);
    std::fs::remove_file(fixture.repository.join("scratch.txt")).unwrap();
    let (engine, store) = engine(&fixture, InPlaceDirtyPolicy::Shelve);
    engine.create_run(new_run(&fixture)).await.unwrap();

    assert_eq!(engine.drive("run1").await, Ok(RunStatus::Succeeded));

    assert!(store
        .pipeline_run("run1")
        .unwrap()
        .unwrap()
        .shelf_id
        .is_none());
    assert_eq!(
        git(&fixture.repository, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feature/1"
    );
}

#[tokio::test]
async fn the_refuse_policy_stops_before_touching_anything() {
    let fixture = fixture();
    let uat_before = git(&fixture.remote, &["rev-parse", "uat"]);
    let (engine, store) = engine(&fixture, InPlaceDirtyPolicy::Refuse);
    engine.create_run(new_run(&fixture)).await.unwrap();

    assert_eq!(engine.drive("run1").await, Ok(RunStatus::Failed));

    let stored = store.pipeline_run("run1").unwrap().unwrap();
    assert!(stored.steps[0]
        .message
        .as_deref()
        .unwrap()
        .contains("uncommitted changes"));
    assert_eq!(git(&fixture.remote, &["rev-parse", "uat"]), uat_before);
    assert_back_on_source_with_changes(&fixture);
}

#[tokio::test]
async fn a_git_operation_in_progress_refuses_the_run() {
    let fixture = fixture();
    git(&fixture.repository, &["stash", "-u", "-q"]);
    let head = git(&fixture.repository, &["rev-parse", "HEAD"]);
    std::fs::write(
        fixture.repository.join(".git/MERGE_HEAD"),
        format!("{head}\n"),
    )
    .unwrap();
    let (engine, store) = engine(&fixture, InPlaceDirtyPolicy::Shelve);
    engine.create_run(new_run(&fixture)).await.unwrap();

    assert_eq!(engine.drive("run1").await, Ok(RunStatus::Failed));

    assert!(store.pipeline_run("run1").unwrap().unwrap().steps[0]
        .message
        .as_deref()
        .unwrap()
        .contains("operation is in progress"));
}

#[tokio::test]
async fn unpushed_local_commits_on_a_target_fail_the_step_and_return_the_user() {
    let fixture = fixture();
    git(&fixture.repository, &["stash", "-u", "-q"]);
    git(&fixture.repository, &["checkout", "-q", "uat"]);
    commit_file(&fixture.repository, "local.txt", "local\n", "local only");
    git(&fixture.repository, &["checkout", "-q", "feature/1"]);
    git(&fixture.repository, &["stash", "pop", "-q"]);
    let uat_before = git(&fixture.remote, &["rev-parse", "uat"]);
    let (engine, store) = engine(&fixture, InPlaceDirtyPolicy::Shelve);
    engine.create_run(new_run(&fixture)).await.unwrap();

    assert_eq!(engine.drive("run1").await, Ok(RunStatus::Failed));

    let stored = store.pipeline_run("run1").unwrap().unwrap();
    assert_eq!(
        stored.steps[0].message.as_deref(),
        Some("Local uat has unpushed commits")
    );
    assert_eq!(stored.steps[1].state, StepState::Skipped);
    assert_eq!(git(&fixture.remote, &["rev-parse", "uat"]), uat_before);
    assert_back_on_source_with_changes(&fixture);
}

#[tokio::test]
async fn a_missing_local_target_is_created_from_the_remote() {
    let fixture = fixture();
    git(&fixture.repository, &["branch", "-D", "dev"]);
    let (engine, _store) = engine(&fixture, InPlaceDirtyPolicy::Shelve);
    engine.create_run(new_run(&fixture)).await.unwrap();

    assert_eq!(engine.drive("run1").await, Ok(RunStatus::Succeeded));

    assert_eq!(
        git(&fixture.repository, &["rev-parse", "refs/heads/dev"]),
        git(&fixture.remote, &["rev-parse", "dev"])
    );
    assert_back_on_source_with_changes(&fixture);
}

fn make_uat_conflict(fixture: &Fixture) {
    git(&fixture.repository, &["stash", "-u", "-q"]);
    git(&fixture.repository, &["checkout", "-q", "uat"]);
    commit_file(
        &fixture.repository,
        "feature.txt",
        "uat version\n",
        "uat edit",
    );
    git(&fixture.repository, &["push", "-q", "origin", "uat"]);
    git(&fixture.repository, &["checkout", "-q", "feature/1"]);
    git(&fixture.repository, &["stash", "pop", "-q"]);
}

#[tokio::test]
async fn conflicts_wait_on_the_target_and_resolving_returns_the_user_to_the_source() {
    let fixture = fixture();
    make_uat_conflict(&fixture);
    let (engine, _store) = engine(&fixture, InPlaceDirtyPolicy::Shelve);
    engine.create_run(new_run(&fixture)).await.unwrap();

    assert_eq!(
        engine.drive("run1").await,
        Ok(RunStatus::WaitingForConflicts)
    );

    // The user's own tree holds the conflict, on the target branch, in the normal conflict flow.
    assert_eq!(
        git(&fixture.repository, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "uat"
    );
    assert!(git(&fixture.repository, &["status", "--porcelain"]).contains("AA feature.txt"));

    std::fs::write(fixture.repository.join("feature.txt"), "resolved\n").unwrap();
    git(&fixture.repository, &["add", "feature.txt"]);
    git(&fixture.repository, &["commit", "-q", "--no-edit"]);

    assert_eq!(
        engine.resume("run1", ResumeAction::ConflictsResolved).await,
        Ok(RunStatus::Succeeded)
    );
    assert_eq!(
        git(&fixture.remote, &["show", "uat:feature.txt"]),
        "resolved"
    );
    assert_back_on_source_with_changes(&fixture);
}

#[tokio::test]
async fn skipping_a_conflicting_target_aborts_it_and_restores_the_user() {
    let fixture = fixture();
    make_uat_conflict(&fixture);
    let uat_remote = git(&fixture.remote, &["rev-parse", "uat"]);
    let (engine, _store) = engine(&fixture, InPlaceDirtyPolicy::Shelve);
    engine.create_run(new_run(&fixture)).await.unwrap();
    engine.drive("run1").await.unwrap();

    assert_eq!(
        engine.resume("run1", ResumeAction::SkipTarget).await,
        Ok(RunStatus::PartiallySucceeded)
    );

    assert_eq!(git(&fixture.remote, &["rev-parse", "uat"]), uat_remote);
    assert_back_on_source_with_changes(&fixture);
}

#[tokio::test]
async fn stopping_a_waiting_run_restores_the_user_too() {
    let fixture = fixture();
    make_uat_conflict(&fixture);
    let (engine, _store) = engine(&fixture, InPlaceDirtyPolicy::Shelve);
    engine.create_run(new_run(&fixture)).await.unwrap();
    engine.drive("run1").await.unwrap();

    assert_eq!(
        engine.resume("run1", ResumeAction::Stop).await,
        Ok(RunStatus::Cancelled)
    );

    assert_back_on_source_with_changes(&fixture);
}

#[tokio::test]
async fn a_target_that_moves_between_fetch_and_push_is_not_overwritten_in_place() {
    use super::workspace::{PipelineWorkspace, PublishOutcome, StepOutcome};
    let fixture = fixture();
    let (engine, _store) = engine(&fixture, InPlaceDirtyPolicy::Shelve);
    let run = engine.create_run(new_run(&fixture)).await.unwrap();
    let repository = fixture.repository.clone();
    let workspace = InPlaceWorkspace::new(
        Arc::new(move |_| Some(repository.clone())),
        Arc::new(|_| InPlaceDirtyPolicy::Shelve),
    );
    let mut step = run.steps[0].clone();
    git(&fixture.repository, &["stash", "-u", "-q"]);
    let prepared = workspace.prepare(&run, &step).await.unwrap();
    step.lease_oid = Some(prepared.lease_oid);
    workspace.merge(&run, &step, "merge").await.unwrap();

    let other = fixture.data_dir.parent().unwrap().join("other-inplace");
    git(
        fixture.data_dir.parent().unwrap(),
        &[
            "clone",
            "-q",
            fixture.remote.to_str().unwrap(),
            "other-inplace",
        ],
    );
    git(&other, &["checkout", "-q", "uat"]);
    commit_file(&other, "other.txt", "other\n", "someone else");
    git(&other, &["push", "-q", "origin", "uat"]);
    let moved = git(&fixture.remote, &["rev-parse", "uat"]);

    assert_eq!(
        workspace.publish(&run, &step).await,
        Ok(PublishOutcome::LeaseRejected)
    );
    assert_eq!(git(&fixture.remote, &["rev-parse", "uat"]), moved);
    workspace
        .finish(&run, &step, StepOutcome::Failed)
        .await
        .unwrap();
    assert_eq!(
        git(&fixture.repository, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feature/1"
    );
}
