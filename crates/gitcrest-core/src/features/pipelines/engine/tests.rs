use std::{collections::VecDeque, sync::Mutex as StdMutex};

use super::*;
use crate::{
    domain::pipeline::{tests::rule, Confirmation, ConflictPolicy, PipelineTarget, StepState},
    features::pipelines::workspace::PreparedStep,
    features::pipelines::workspace::RecoveryFinding,
    storage::RepositoryStore,
};

#[derive(Default)]
struct Script {
    merges: VecDeque<Result<MergeOutcome, PipelineStepError>>,
    publishes: VecDeque<Result<PublishOutcome, PipelineStepError>>,
    prepare_failures: VecDeque<PipelineStepError>,
    abort_failure: Option<PipelineStepError>,
    begin_failure: Option<PipelineStepError>,
    shelf: Option<String>,
    end_failure: Option<PipelineStepError>,
    cleanup_failure: Option<PipelineStepError>,
    findings: VecDeque<RecoveryFinding>,
}

struct FakeWorkspace {
    store: Arc<RepositoryStore>,
    script: StdMutex<Script>,
    calls: StdMutex<Vec<String>>,
}

impl FakeWorkspace {
    fn new(store: Arc<RepositoryStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            script: StdMutex::new(Script::default()),
            calls: StdMutex::new(Vec::new()),
        })
    }

    fn script(&self, edit: impl FnOnce(&mut Script)) {
        edit(&mut self.script.lock().unwrap());
    }

    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    /// The engine must have persisted `expected` before it asked for this Git work.
    fn assert_persisted(&self, step: &PipelineStep, expected: StepState) {
        let stored = self.store.pipeline_run(&step.run_id).unwrap().unwrap();
        assert_eq!(stored.steps[step.position as usize].state, expected);
    }
}

impl PipelineWorkspace for FakeWorkspace {
    async fn prepare(
        &self,
        _run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PreparedStep, PipelineStepError> {
        self.assert_persisted(step, StepState::Preparing);
        self.record(format!("prepare {}", step.target_branch));
        if let Some(error) = self.script.lock().unwrap().prepare_failures.pop_front() {
            return Err(error);
        }
        Ok(PreparedStep {
            lease_oid: "b".repeat(40),
            workspace_path: Some(format!("/work/{}", step.target_branch)),
            repo_context: format!("eph-{}", step.target_branch),
        })
    }

    async fn merge(
        &self,
        _run: &PipelineRun,
        step: &PipelineStep,
        message: &str,
    ) -> Result<MergeOutcome, PipelineStepError> {
        self.assert_persisted(step, StepState::Merging);
        self.record(format!("merge {} '{message}'", step.target_branch));
        self.script
            .lock()
            .unwrap()
            .merges
            .pop_front()
            .unwrap_or(Ok(MergeOutcome::Merged {
                oid: "c".repeat(40),
            }))
    }

    async fn abort_merge(
        &self,
        _run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<(), PipelineStepError> {
        self.record(format!("abort {}", step.target_branch));
        match self.script.lock().unwrap().abort_failure.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    async fn publish(
        &self,
        _run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PublishOutcome, PipelineStepError> {
        self.assert_persisted(step, StepState::Pushing);
        assert_eq!(step.lease_oid.as_deref(), Some("b".repeat(40).as_str()));
        self.record(format!("publish {}", step.target_branch));
        self.script
            .lock()
            .unwrap()
            .publishes
            .pop_front()
            .unwrap_or(Ok(PublishOutcome::Pushed))
    }

    async fn begin_run(&self, _run: &PipelineRun) -> Result<Option<String>, PipelineStepError> {
        self.record("begin".into());
        let mut script = self.script.lock().unwrap();
        match script.begin_failure.take() {
            Some(error) => Err(error),
            None => Ok(script.shelf.clone()),
        }
    }

    async fn end_run(&self, _run: &PipelineRun) -> Result<(), PipelineStepError> {
        self.record("end".into());
        match self.script.lock().unwrap().end_failure.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    async fn inspect(&self, _run: &PipelineRun, step: &PipelineStep) -> RecoveryFinding {
        self.record(format!("inspect {}", step.target_branch));
        self.script
            .lock()
            .unwrap()
            .findings
            .pop_front()
            .unwrap_or(RecoveryFinding::NotMerged)
    }

    async fn finish(
        &self,
        _run: &PipelineRun,
        step: &PipelineStep,
        outcome: StepOutcome,
    ) -> Result<(), PipelineStepError> {
        self.record(format!("finish {} {outcome:?}", step.target_branch));
        match self.script.lock().unwrap().cleanup_failure.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

type Engine = PipelineEngine<RepositoryStore, FakeWorkspace>;

fn setup() -> (Arc<RepositoryStore>, Arc<FakeWorkspace>, Engine) {
    let store = Arc::new(RepositoryStore::default());
    store.insert_test_repository("repo");
    let workspace = FakeWorkspace::new(store.clone());
    let engine = PipelineEngine::new(store.clone(), workspace.clone());
    (store, workspace, engine)
}

fn auto_rule() -> PipelineRule {
    let mut rule = rule();
    rule.confirmation = Confirmation::Auto;
    rule
}

fn new_run(run_id: &str, rule: PipelineRule) -> NewRun {
    NewRun {
        run_id: run_id.into(),
        repo_id: "repo".into(),
        rule,
        source_branch: "feature/1".into(),
        source_oid: "a".repeat(40),
        execution_mode: ExecutionMode::TemporaryWorktree,
        hold: false,
        now_ms: 1,
    }
}

fn states(store: &RepositoryStore, run_id: &str) -> Vec<StepState> {
    store
        .pipeline_run(run_id)
        .unwrap()
        .unwrap()
        .steps
        .iter()
        .map(|step| step.state)
        .collect()
}

#[tokio::test]
async fn cleanup_failure_stops_later_targets_without_custom_commands() {
    let (store, workspace, engine) = setup();
    workspace.script(|script| {
        script.cleanup_failure = Some(PipelineStepError::workspace("directory is protected"))
    });
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();
    assert_eq!(engine.drive("run").await.unwrap(), RunStatus::Interrupted);
    assert_eq!(
        states(&store, "run"),
        [StepState::CleanupRequired, StepState::Pending]
    );
    let run = store.pipeline_run("run").unwrap().unwrap();
    assert!(run.steps[0]
        .message
        .as_deref()
        .unwrap()
        .contains("Cleanup failed"));
    assert!(!workspace.calls().iter().any(|call| call == "prepare dev"));
    assert!(
        workspace.calls().iter().any(|call| call == "publish uat"),
        "the already-published target is not rolled back"
    );
    assert!(
        !workspace.calls().iter().any(|call| call == "end"),
        "do not restore a shelf before source checkout succeeds"
    );
    assert_eq!(
        engine.begin_interrupted("run").await,
        Err(EngineError::InvalidState)
    );
    assert_eq!(
        engine.abandon_interrupted("run", false).await,
        Err(EngineError::InvalidState)
    );
    assert_eq!(
        engine.recover_run("run").await.unwrap(),
        Some(RecoveryProposal::CleanupRequired)
    );
    assert!(!workspace
        .calls()
        .iter()
        .any(|call| call.starts_with("inspect ")));
    assert_eq!(
        engine.abandon_interrupted("run", true).await.unwrap(),
        RunStatus::Cancelled
    );
    assert_eq!(
        workspace
            .calls()
            .iter()
            .filter(|call| *call == "publish uat")
            .count(),
        1
    );
    assert_eq!(workspace.calls().last().map(String::as_str), Some("end"));
}

#[tokio::test]
async fn merges_and_pushes_every_target_in_order() {
    let (store, workspace, engine) = setup();
    let run = engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();
    assert_eq!(run.status, RunStatus::Running);

    assert_eq!(engine.drive("run").await, Ok(RunStatus::Succeeded));

    assert_eq!(
        workspace.calls(),
        [
            "begin",
            "prepare uat",
            "merge uat 'Merge branch 'feature/1' into uat'",
            "publish uat",
            "finish uat Done",
            "prepare dev",
            "merge dev 'Merge branch 'feature/1' into dev'",
            "publish dev",
            "finish dev Done",
            "end",
        ]
    );
    let stored = store.pipeline_run("run").unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Succeeded);
    assert_eq!(
        stored.steps[0].merge_oid.as_deref(),
        Some("c".repeat(40).as_str())
    );
    assert_eq!(
        stored.steps[0].ephemeral_repo_id.as_deref(),
        Some("eph-uat")
    );
    assert_eq!(stored.steps[0].workspace_path.as_deref(), Some("/work/uat"));
}

#[tokio::test]
async fn up_to_date_target_is_not_pushed_and_counts_as_success() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.merges.push_back(Ok(MergeOutcome::UpToDate)));
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();

    assert_eq!(engine.drive("run").await, Ok(RunStatus::Succeeded));

    assert_eq!(
        states(&store, "run"),
        [StepState::UpToDate, StepState::Done]
    );
    assert!(!workspace.calls().contains(&"publish uat".to_string()));
    assert!(workspace.calls().contains(&"publish dev".to_string()));
}

#[tokio::test]
async fn merge_only_rules_do_not_push() {
    let (store, workspace, engine) = setup();
    let mut rule = auto_rule();
    rule.push_after_merge = false;
    engine.create_run(new_run("run", rule)).await.unwrap();

    assert_eq!(engine.drive("run").await, Ok(RunStatus::Succeeded));

    assert_eq!(states(&store, "run"), [StepState::Done, StepState::Done]);
    assert!(workspace
        .calls()
        .iter()
        .all(|call| !call.starts_with("publish")));
}

#[tokio::test]
async fn skip_policy_aborts_the_merge_and_continues_with_the_next_target() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.merges.push_back(Ok(MergeOutcome::Conflicts)));
    let mut rule = auto_rule();
    rule.on_conflict = ConflictPolicy::SkipTarget;
    engine.create_run(new_run("run", rule)).await.unwrap();

    assert_eq!(engine.drive("run").await, Ok(RunStatus::PartiallySucceeded));

    assert_eq!(states(&store, "run"), [StepState::Skipped, StepState::Done]);
    assert!(workspace.calls().contains(&"abort uat".to_string()));
}

#[tokio::test]
async fn stop_policy_aborts_and_leaves_later_targets_unrun() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.merges.push_back(Ok(MergeOutcome::Conflicts)));
    let mut rule = auto_rule();
    rule.on_conflict = ConflictPolicy::StopRun;
    engine.create_run(new_run("run", rule)).await.unwrap();

    assert_eq!(engine.drive("run").await, Ok(RunStatus::Failed));

    assert_eq!(
        states(&store, "run"),
        [StepState::Failed, StepState::Skipped]
    );
    assert!(!workspace.calls().iter().any(|c| c.contains("dev")));
}

#[tokio::test]
async fn resolver_policy_waits_and_resuming_pushes_then_continues() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.merges.push_back(Ok(MergeOutcome::Conflicts)));
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();

    assert_eq!(
        engine.drive("run").await,
        Ok(RunStatus::WaitingForConflicts)
    );
    assert_eq!(
        states(&store, "run"),
        [StepState::WaitingForConflicts, StepState::Pending]
    );
    assert_eq!(
        store.pipeline_run("run").unwrap().unwrap().status,
        RunStatus::WaitingForConflicts
    );
    // Driving a paused run does nothing.
    assert_eq!(
        engine.drive("run").await,
        Ok(RunStatus::WaitingForConflicts)
    );

    assert_eq!(
        engine.resume("run", ResumeAction::ConflictsResolved).await,
        Ok(RunStatus::Succeeded)
    );
    assert_eq!(states(&store, "run"), [StepState::Done, StepState::Done]);
    let calls = workspace.calls();
    let publish_uat = calls.iter().position(|c| c == "publish uat").unwrap();
    let prepare_dev = calls.iter().position(|c| c == "prepare dev").unwrap();
    assert!(publish_uat < prepare_dev);
}

#[tokio::test]
async fn ask_after_resolving_waits_for_confirmation_before_the_next_target() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.merges.push_back(Ok(MergeOutcome::Conflicts)));
    let mut rule = auto_rule();
    rule.after_conflict_resolved = AfterConflictResolved::Ask;
    engine.create_run(new_run("run", rule)).await.unwrap();
    engine.drive("run").await.unwrap();

    assert_eq!(
        engine.resume("run", ResumeAction::ConflictsResolved).await,
        Ok(RunStatus::PendingConfirmation)
    );
    assert_eq!(states(&store, "run"), [StepState::Done, StepState::Pending]);
    assert!(!workspace.calls().iter().any(|c| c == "prepare dev"));

    assert_eq!(engine.start_run("run").await, Ok(RunStatus::Succeeded));
    assert_eq!(states(&store, "run"), [StepState::Done, StepState::Done]);
}

#[tokio::test]
async fn resume_can_skip_the_target_or_stop_the_run() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.merges.push_back(Ok(MergeOutcome::Conflicts)));
    engine
        .create_run(new_run("skip", auto_rule()))
        .await
        .unwrap();
    engine.drive("skip").await.unwrap();
    assert_eq!(
        engine.resume("skip", ResumeAction::SkipTarget).await,
        Ok(RunStatus::PartiallySucceeded)
    );
    assert_eq!(
        states(&store, "skip"),
        [StepState::Skipped, StepState::Done]
    );

    workspace.script(|s| s.merges.push_back(Ok(MergeOutcome::Conflicts)));
    engine
        .create_run(new_run("stop", auto_rule()))
        .await
        .unwrap();
    engine.drive("stop").await.unwrap();
    assert_eq!(
        engine.resume("stop", ResumeAction::Stop).await,
        Ok(RunStatus::Cancelled)
    );
    assert_eq!(
        states(&store, "stop"),
        [StepState::Skipped, StepState::Skipped]
    );
    assert_eq!(
        engine.resume("stop", ResumeAction::Stop).await,
        Err(EngineError::InvalidState)
    );
}

#[tokio::test]
async fn a_rejected_lease_is_retried_once_with_a_fresh_prepare_and_merge() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.publishes.push_back(Ok(PublishOutcome::LeaseRejected)));
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();

    assert_eq!(engine.drive("run").await, Ok(RunStatus::Succeeded));

    let calls = workspace.calls();
    assert_eq!(calls.iter().filter(|c| *c == "prepare uat").count(), 2);
    assert_eq!(calls.iter().filter(|c| *c == "publish uat").count(), 2);
    assert!(calls.contains(&"finish uat Retry".to_string()));
    assert_eq!(states(&store, "run"), [StepState::Done, StepState::Done]);
}

#[tokio::test]
async fn a_second_rejected_lease_fails_the_step_without_overwriting() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| {
        s.publishes.push_back(Ok(PublishOutcome::LeaseRejected));
        s.publishes.push_back(Ok(PublishOutcome::LeaseRejected));
    });
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();

    assert_eq!(engine.drive("run").await, Ok(RunStatus::Failed));

    let stored = store.pipeline_run("run").unwrap().unwrap();
    assert_eq!(stored.steps[0].state, StepState::Failed);
    assert_eq!(
        stored.steps[0].message.as_deref(),
        Some("uat changed on the remote twice while merging; run again")
    );
    assert_eq!(stored.steps[1].state, StepState::Skipped);
    assert_eq!(
        workspace
            .calls()
            .iter()
            .filter(|c| *c == "publish uat")
            .count(),
        2
    );
}

#[tokio::test]
async fn workspace_errors_fail_the_step_and_skip_the_rest() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| {
        s.prepare_failures
            .push_back(PipelineStepError::new("fetch failed"))
    });
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();

    assert_eq!(engine.drive("run").await, Ok(RunStatus::Failed));

    let stored = store.pipeline_run("run").unwrap().unwrap();
    assert_eq!(stored.steps[0].message.as_deref(), Some("fetch failed"));
    assert_eq!(
        states(&store, "run"),
        [StepState::Failed, StepState::Skipped]
    );
    assert!(workspace.calls().contains(&"finish uat Failed".to_string()));
}

#[tokio::test]
async fn failed_abort_is_reported_on_the_step() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| {
        s.merges.push_back(Ok(MergeOutcome::Conflicts));
        s.abort_failure = Some(PipelineStepError::new("locked"));
    });
    let mut rule = auto_rule();
    rule.on_conflict = ConflictPolicy::SkipTarget;
    engine.create_run(new_run("run", rule)).await.unwrap();
    engine.drive("run").await.unwrap();

    let stored = store.pipeline_run("run").unwrap().unwrap();
    assert_eq!(
        stored.steps[0].message.as_deref(),
        Some("Skipped after conflicts; aborting the merge failed: locked")
    );
    assert_eq!(stored.status, RunStatus::Interrupted);
    assert_eq!(stored.steps[0].state, StepState::CleanupRequired);
    assert!(!workspace
        .calls()
        .iter()
        .any(|call| call.starts_with("finish ") || call == "end" || call == "prepare dev"));
}

#[tokio::test]
async fn rejected_lease_does_not_retry_when_releasing_the_workspace_fails() {
    let (store, workspace, engine) = setup();
    workspace.script(|script| {
        script
            .publishes
            .push_back(Ok(PublishOutcome::LeaseRejected));
        script.cleanup_failure = Some(PipelineStepError::workspace("directory locked"));
    });
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();
    assert_eq!(engine.drive("run").await.unwrap(), RunStatus::Interrupted);
    assert_eq!(
        states(&store, "run"),
        [StepState::CleanupRequired, StepState::Pending]
    );
    let calls = workspace.calls();
    assert_eq!(
        calls.iter().filter(|call| *call == "prepare uat").count(),
        1
    );
    assert_eq!(
        calls.iter().filter(|call| *call == "publish uat").count(),
        1
    );
    assert!(!calls.iter().any(|call| call == "end"));
    assert!(store.pipeline_run("run").unwrap().unwrap().steps[0]
        .message
        .as_ref()
        .unwrap()
        .contains("cleanup before retry failed"));
}

#[tokio::test]
async fn main_failure_and_cleanup_failure_are_both_kept_without_restoring_the_shelf() {
    let (store, workspace, engine) = setup();
    workspace.script(|script| {
        script
            .prepare_failures
            .push_back(PipelineStepError::new("fetch failed"));
        script.cleanup_failure = Some(PipelineStepError::workspace("return checkout failed"));
    });
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();
    assert_eq!(engine.drive("run").await.unwrap(), RunStatus::Interrupted);
    let stored = store.pipeline_run("run").unwrap().unwrap();
    let message = stored.steps[0].message.as_deref().unwrap();
    assert!(message.contains("fetch failed") && message.contains("return checkout failed"));
    assert!(!workspace
        .calls()
        .iter()
        .any(|call| call == "end" || call == "prepare dev"));
    workspace.script(|script| {
        script.cleanup_failure = Some(PipelineStepError::workspace("still locked"))
    });
    assert_eq!(
        engine.abandon_interrupted("run", true).await.unwrap(),
        RunStatus::Interrupted
    );
    let stored = store.pipeline_run("run").unwrap().unwrap();
    let message = stored.steps[0].message.as_deref().unwrap();
    assert!(message.contains("fetch failed") && message.contains("still locked"));
}

#[tokio::test]
async fn stop_during_conflicts_does_not_report_cancelled_if_cleanup_fails() {
    let (store, workspace, engine) = setup();
    workspace.script(|script| script.merges.push_back(Ok(MergeOutcome::Conflicts)));
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();
    assert_eq!(
        engine.drive("run").await.unwrap(),
        RunStatus::WaitingForConflicts
    );
    workspace.script(|script| {
        script.cleanup_failure = Some(PipelineStepError::workspace("return checkout failed"))
    });
    assert_eq!(
        engine.resume("run", ResumeAction::Stop).await.unwrap(),
        RunStatus::Interrupted
    );
    assert_eq!(
        states(&store, "run"),
        [StepState::CleanupRequired, StepState::Pending]
    );
    assert!(!workspace.calls().iter().any(|call| call == "end"));
    assert_eq!(
        engine.abandon_interrupted("run", true).await.unwrap(),
        RunStatus::Cancelled
    );
    assert_eq!(
        states(&store, "run"),
        [StepState::Skipped, StepState::Skipped]
    );
}

#[tokio::test]
async fn abandoning_keeps_the_run_interrupted_until_cleanup_really_succeeds() {
    let (store, workspace, _) = setup();
    let engine = crashed_in(&store, &workspace, StepState::Merging, RunStatus::Running);
    engine.recover_run("run").await.unwrap();
    workspace
        .script(|script| script.cleanup_failure = Some(PipelineStepError::workspace("locked")));
    assert_eq!(
        engine.abandon_interrupted("run", true).await.unwrap(),
        RunStatus::Interrupted
    );
    assert_eq!(
        states(&store, "run"),
        [StepState::CleanupRequired, StepState::Pending]
    );
    assert!(!workspace.calls().iter().any(|call| call == "end"));
    let restarted = PipelineEngine::new(store.clone(), workspace.clone());
    assert_eq!(
        restarted.recover_run("run").await.unwrap(),
        Some(RecoveryProposal::CleanupRequired)
    );
    assert_eq!(
        restarted.begin_interrupted("run").await,
        Err(EngineError::InvalidState)
    );
    let (one, two) = tokio::join!(
        restarted.abandon_interrupted("run", true),
        restarted.abandon_interrupted("run", true)
    );
    assert_eq!(one.unwrap(), RunStatus::Cancelled);
    assert_eq!(two, Err(EngineError::InvalidState));
    assert_eq!(
        workspace
            .calls()
            .iter()
            .filter(|call| *call == "end")
            .count(),
        1
    );
}

#[tokio::test]
async fn rules_that_ask_wait_for_confirmation_and_start_on_request() {
    let (store, workspace, engine) = setup();
    let run = engine.create_run(new_run("run", rule())).await.unwrap();
    assert_eq!(run.status, RunStatus::PendingConfirmation);
    assert!(workspace.calls().is_empty());
    assert_eq!(
        engine.drive("run").await,
        Ok(RunStatus::PendingConfirmation)
    );

    assert_eq!(engine.start_run("run").await, Ok(RunStatus::Succeeded));
    assert_eq!(states(&store, "run"), [StepState::Done, StepState::Done]);
    assert_eq!(
        engine.start_run("run").await,
        Err(EngineError::InvalidState)
    );
}

#[tokio::test]
async fn protected_targets_always_ask_even_when_the_rule_says_auto() {
    let (_store, _workspace, engine) = setup();
    let mut rule = auto_rule();
    rule.targets[0] = PipelineTarget {
        branch: "main".into(),
        remote: "origin".into(),
    };
    let run = engine.create_run(new_run("run", rule)).await.unwrap();
    assert_eq!(run.status, RunStatus::PendingConfirmation);
    assert_eq!(run.rule.confirmation, Confirmation::Ask);
}

#[tokio::test]
async fn a_second_trigger_is_queued_until_the_active_run_ends() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.merges.push_back(Ok(MergeOutcome::Conflicts)));
    engine
        .create_run(new_run("first", auto_rule()))
        .await
        .unwrap();
    engine.drive("first").await.unwrap();

    let second = engine
        .create_run(new_run("second", auto_rule()))
        .await
        .unwrap();
    assert_eq!(second.status, RunStatus::PendingConfirmation);
    assert_eq!(engine.start_run("second").await, Err(EngineError::Busy));

    engine
        .resume("first", ResumeAction::ConflictsResolved)
        .await
        .unwrap();
    assert_eq!(engine.start_run("second").await, Ok(RunStatus::Succeeded));
    assert_eq!(states(&store, "second"), [StepState::Done, StepState::Done]);
}

#[tokio::test]
async fn refuses_a_run_whose_source_is_a_target_of_an_active_run() {
    let (_store, workspace, engine) = setup();
    workspace.script(|s| s.merges.push_back(Ok(MergeOutcome::Conflicts)));
    engine
        .create_run(new_run("first", auto_rule()))
        .await
        .unwrap();
    engine.drive("first").await.unwrap();

    let mut second = new_run("second", auto_rule());
    second.source_branch = "uat".into();
    assert_eq!(
        engine.create_run(second).await.err(),
        Some(EngineError::LoopGuard("uat".into()))
    );
}

#[tokio::test]
async fn invalid_rules_are_rejected() {
    let (_store, _workspace, engine) = setup();
    let mut rule = auto_rule();
    rule.targets.clear();
    assert_eq!(
        engine.create_run(new_run("run", rule)).await.err(),
        Some(EngineError::InvalidRule(PipelineRuleError::NoTargets))
    );
    assert_eq!(engine.drive("missing").await, Err(EngineError::RunNotFound));
}

#[test]
fn pipeline_pushes_never_trigger_rules() {
    let mut disabled = rule();
    disabled.rule_id = "off".into();
    disabled.enabled = false;
    let rules = vec![rule(), disabled];

    let matched = triggered_rules(&rules, "feature/1", PushOrigin::User);
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].rule_id, "r_01");
    assert!(triggered_rules(&rules, "feature/1", PushOrigin::Pipeline).is_empty());
    assert!(triggered_rules(&rules, "uat", PushOrigin::User).is_empty());
}

#[tokio::test]
async fn begin_and_end_hooks_bracket_the_run_and_the_shelf_id_is_persisted() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.shelf = Some("shelf-1".into()));
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();

    assert_eq!(engine.drive("run").await, Ok(RunStatus::Succeeded));

    let calls = workspace.calls();
    assert_eq!(calls.first().map(String::as_str), Some("begin"));
    assert_eq!(calls.last().map(String::as_str), Some("end"));
    assert_eq!(calls.iter().filter(|c| *c == "begin").count(), 1);
    assert_eq!(calls.iter().filter(|c| *c == "end").count(), 1);
    let stored = store.pipeline_run("run").unwrap().unwrap();
    assert_eq!(stored.shelf_id.as_deref(), Some("shelf-1"));
}

#[tokio::test]
async fn a_failing_begin_hook_fails_the_run_before_any_target_is_touched() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.begin_failure = Some(PipelineStepError::new("working tree is dirty")));
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();

    assert_eq!(engine.drive("run").await, Ok(RunStatus::Failed));

    let stored = store.pipeline_run("run").unwrap().unwrap();
    assert_eq!(
        stored.steps[0].message.as_deref(),
        Some("working tree is dirty")
    );
    assert_eq!(
        states(&store, "run"),
        [StepState::Failed, StepState::Skipped]
    );
    assert!(!workspace.calls().iter().any(|c| c.starts_with("prepare")));
}

#[tokio::test]
async fn stopping_a_waiting_run_still_runs_the_end_hook_and_reports_its_failure() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| {
        s.merges.push_back(Ok(MergeOutcome::Conflicts));
        s.end_failure = Some(PipelineStepError::new("restoring your changes failed"));
    });
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();
    engine.drive("run").await.unwrap();

    assert_eq!(
        engine.resume("run", ResumeAction::Stop).await,
        Ok(RunStatus::Cancelled)
    );

    assert_eq!(workspace.calls().last().map(String::as_str), Some("end"));
    let stored = store.pipeline_run("run").unwrap().unwrap();
    assert!(stored.steps[1]
        .message
        .as_deref()
        .unwrap()
        .contains("restoring your changes failed"));
}

#[tokio::test]
async fn a_failing_end_hook_is_reported_on_the_last_step_of_a_finished_run() {
    let (store, workspace, engine) = setup();
    workspace.script(|s| s.end_failure = Some(PipelineStepError::new("stash pop conflicted")));
    engine
        .create_run(new_run("run", auto_rule()))
        .await
        .unwrap();

    assert_eq!(engine.drive("run").await, Ok(RunStatus::Succeeded));

    let stored = store.pipeline_run("run").unwrap().unwrap();
    assert_eq!(
        stored.steps[1].message.as_deref(),
        Some("stash pop conflicted")
    );
}

/// Simulates GitCrest closing while a step was in `state`: the run and step are persisted,
/// and a fresh engine over the same store takes over.
fn crashed_in(
    store: &Arc<RepositoryStore>,
    workspace: &Arc<FakeWorkspace>,
    state: StepState,
    status: RunStatus,
) -> Engine {
    let mut run = crate::domain::pipeline::tests::run(vec![
        crate::domain::pipeline::tests::step(0, state),
        crate::domain::pipeline::tests::step(1, StepState::Pending),
    ]);
    run.rule = auto_rule();
    run.status = status;
    run.steps[0].target_branch = "uat".into();
    run.steps[1].target_branch = "dev".into();
    if state != StepState::Pending {
        run.steps[0].lease_oid = Some("b".repeat(40));
    }
    store.insert_pipeline_run(&run).unwrap();
    PipelineEngine::new(store.clone(), workspace.clone())
}

#[tokio::test]
async fn a_restart_during_any_step_state_leads_to_the_matching_proposal() {
    let cases = [
        (StepState::Pending, None, RecoveryProposal::RestartStep),
        (
            StepState::Preparing,
            Some(RecoveryFinding::NotMerged),
            RecoveryProposal::RestartStep,
        ),
        (
            StepState::Merging,
            Some(RecoveryFinding::MergeInProgress),
            RecoveryProposal::ResumeConflicts,
        ),
        (
            StepState::WaitingForConflicts,
            Some(RecoveryFinding::MergeInProgress),
            RecoveryProposal::ResumeConflicts,
        ),
        (
            StepState::WaitingForConflicts,
            Some(RecoveryFinding::MergedNotPushed),
            RecoveryProposal::ResumePush,
        ),
        (
            StepState::Pushing,
            Some(RecoveryFinding::MergedNotPushed),
            RecoveryProposal::ResumePush,
        ),
        (
            StepState::Finishing,
            Some(RecoveryFinding::LeftOnTarget),
            RecoveryProposal::CleanupRequired,
        ),
        (
            StepState::CleanupRequired,
            None,
            RecoveryProposal::CleanupRequired,
        ),
    ];
    for (state, finding, expected) in cases {
        let (store, workspace, _) = setup();
        workspace.script(|s| s.findings.extend(finding));
        let status = if state == StepState::WaitingForConflicts {
            RunStatus::WaitingForConflicts
        } else {
            RunStatus::Running
        };
        let engine = crashed_in(&store, &workspace, state, status);

        assert_eq!(
            engine.recover_run("run").await,
            Ok(Some(expected)),
            "{state:?}"
        );

        let stored = store.pipeline_run("run").unwrap().unwrap();
        let expected_status = if expected == RecoveryProposal::ResumeConflicts {
            RunStatus::WaitingForConflicts
        } else {
            RunStatus::Interrupted
        };
        assert_eq!(stored.status, expected_status, "{state:?}");
        if expected == RecoveryProposal::ResumeConflicts {
            assert_eq!(stored.steps[0].state, StepState::WaitingForConflicts);
        }
    }
}

#[tokio::test]
async fn a_lost_workspace_fails_the_run_and_skips_the_rest() {
    let (store, workspace, _) = setup();
    workspace.script(|s| s.findings.push_back(RecoveryFinding::WorkspaceLost));
    let engine = crashed_in(&store, &workspace, StepState::Merging, RunStatus::Running);

    assert_eq!(engine.recover_run("run").await, Ok(None));

    let stored = store.pipeline_run("run").unwrap().unwrap();
    assert_eq!(stored.status, RunStatus::Failed);
    assert_eq!(
        states(&store, "run"),
        [StepState::Failed, StepState::Skipped]
    );
    assert!(stored.steps[0].message.as_deref().unwrap().contains("lost"));
    assert!(workspace.calls().contains(&"end".to_string()));
}

#[tokio::test]
async fn recovery_ignores_runs_that_are_not_in_progress() {
    let (_store, _workspace, engine) = setup();
    engine.create_run(new_run("pending", rule())).await.unwrap();
    assert_eq!(engine.recover_run("pending").await, Ok(None));
    assert_eq!(
        engine.recover_run("missing").await,
        Err(EngineError::RunNotFound)
    );
}

#[tokio::test]
async fn resuming_an_interrupted_push_skips_prepare_and_merge_for_that_target() {
    let (store, workspace, _) = setup();
    workspace.script(|s| s.findings.push_back(RecoveryFinding::MergedNotPushed));
    let engine = crashed_in(&store, &workspace, StepState::Pushing, RunStatus::Running);
    engine.recover_run("run").await.unwrap();

    assert_eq!(
        engine.resume_interrupted("run", true).await,
        Ok(RunStatus::Succeeded)
    );

    let calls = workspace.calls();
    assert!(!calls
        .iter()
        .any(|c| c == "prepare uat" || c.starts_with("merge uat")));
    assert!(calls.contains(&"publish uat".to_string()));
    assert!(calls.contains(&"prepare dev".to_string()));
    assert_eq!(states(&store, "run"), [StepState::Done, StepState::Done]);
}

#[tokio::test]
async fn restarting_an_interrupted_step_prepares_and_merges_it_again() {
    let (store, workspace, _) = setup();
    let engine = crashed_in(&store, &workspace, StepState::Merging, RunStatus::Running);
    engine.recover_run("run").await.unwrap();

    assert_eq!(
        engine.resume_interrupted("run", false).await,
        Ok(RunStatus::Succeeded)
    );

    assert!(workspace.calls().contains(&"prepare uat".to_string()));
    assert_eq!(
        engine.resume_interrupted("run", false).await,
        Err(EngineError::InvalidState)
    );
}

#[tokio::test]
async fn abandoning_an_interrupted_run_can_return_to_the_source_or_stay() {
    let (store, workspace, _) = setup();
    workspace.script(|s| s.findings.push_back(RecoveryFinding::LeftOnTarget));
    let engine = crashed_in(&store, &workspace, StepState::Merging, RunStatus::Running);
    engine.recover_run("run").await.unwrap();

    assert_eq!(
        engine.abandon_interrupted("run", true).await,
        Ok(RunStatus::Cancelled)
    );
    let calls = workspace.calls();
    assert!(calls.contains(&"finish uat Skipped".to_string()));
    assert_eq!(calls.last().map(String::as_str), Some("end"));
    assert_eq!(
        states(&store, "run"),
        [StepState::Skipped, StepState::Skipped]
    );

    let (store, workspace, _) = setup();
    workspace.script(|s| s.findings.push_back(RecoveryFinding::LeftOnTarget));
    let engine = crashed_in(&store, &workspace, StepState::Merging, RunStatus::Running);
    engine.recover_run("run").await.unwrap();
    assert_eq!(
        engine.abandon_interrupted("run", false).await,
        Ok(RunStatus::Cancelled)
    );
    let calls = workspace.calls();
    assert!(calls.contains(&"finish uat Stay".to_string()));
    assert!(!calls.contains(&"end".to_string()));
}

#[tokio::test]
async fn an_interrupted_run_keeps_the_repository_busy() {
    let (store, workspace, engine) = setup();
    let _ = crashed_in(
        &store,
        &workspace,
        StepState::Merging,
        RunStatus::Interrupted,
    );

    let queued = engine
        .create_run(new_run("second", auto_rule()))
        .await
        .unwrap();

    assert_eq!(queued.status, RunStatus::PendingConfirmation);
    assert_eq!(engine.start_run("second").await, Err(EngineError::Busy));
}
