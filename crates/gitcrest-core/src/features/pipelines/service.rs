use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{
    domain::{
        error::RepositoryError,
        pipeline::{ExecutionMode, PipelineRun, PipelineStep, RunStatus, StepState},
    },
    events::publisher::EventBus,
    ports::{pipelines::PipelineStorePort, repository::RepositoryCatalogPort},
};

use super::{
    engine::{triggered_rules, EngineError, NewRun, PipelineEngine, PushOrigin, ResumeAction},
    ephemeral::EphemeralContexts,
    workspace::{
        MergeOutcome, PipelineStepError, PipelineWorkspace, PreparedStep, PublishOutcome,
        StepOutcome,
    },
    worktree::WorktreeWorkspace,
};

/// Picks the workspace by the execution mode the run started with.
pub(crate) struct ModeWorkspace {
    worktree: WorktreeWorkspace,
}

fn unavailable() -> PipelineStepError {
    PipelineStepError::new("Switching branches in place is not available yet")
}

impl ModeWorkspace {
    pub(crate) fn worktree(&self) -> &WorktreeWorkspace {
        &self.worktree
    }
}

impl PipelineWorkspace for ModeWorkspace {
    async fn prepare(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PreparedStep, PipelineStepError> {
        match run.execution_mode {
            ExecutionMode::TemporaryWorktree => self.worktree.prepare(run, step).await,
            ExecutionMode::SwitchInPlace => Err(unavailable()),
        }
    }

    async fn merge(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
        message: &str,
    ) -> Result<MergeOutcome, PipelineStepError> {
        match run.execution_mode {
            ExecutionMode::TemporaryWorktree => self.worktree.merge(run, step, message).await,
            ExecutionMode::SwitchInPlace => Err(unavailable()),
        }
    }

    async fn abort_merge(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<(), PipelineStepError> {
        match run.execution_mode {
            ExecutionMode::TemporaryWorktree => self.worktree.abort_merge(run, step).await,
            ExecutionMode::SwitchInPlace => Err(unavailable()),
        }
    }

    async fn publish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PublishOutcome, PipelineStepError> {
        match run.execution_mode {
            ExecutionMode::TemporaryWorktree => self.worktree.publish(run, step).await,
            ExecutionMode::SwitchInPlace => Err(unavailable()),
        }
    }

    async fn finish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
        outcome: StepOutcome,
    ) -> Result<(), PipelineStepError> {
        match run.execution_mode {
            ExecutionMode::TemporaryWorktree => self.worktree.finish(run, step, outcome).await,
            ExecutionMode::SwitchInPlace => Ok(()),
        }
    }
}

type Engine = PipelineEngine<dyn PipelineStorePort, ModeWorkspace>;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PipelineServiceError {
    Storage,
    RunNotFound,
    RuleNotFound,
    /// Not valid for the run's current state, or another run holds the repository.
    Conflict(String),
    Invalid(String),
}

impl From<EngineError> for PipelineServiceError {
    fn from(error: EngineError) -> Self {
        match error {
            EngineError::Storage => Self::Storage,
            EngineError::RunNotFound => Self::RunNotFound,
            EngineError::InvalidState => {
                Self::Conflict("The run is not in a state that allows this action.".into())
            }
            EngineError::Busy => {
                Self::Conflict("Another pipeline run of this repository is in progress.".into())
            }
            EngineError::LoopGuard(branch) => Self::Conflict(format!(
                "{branch} is a target of a pipeline run in progress."
            )),
            EngineError::InvalidRule(_) => Self::Invalid("The rule is not valid.".into()),
        }
    }
}

impl From<RepositoryError> for PipelineServiceError {
    fn from(_: RepositoryError) -> Self {
        Self::Storage
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PushedBranch {
    pub repo_id: String,
    pub branch: String,
    pub oid: String,
}

pub(crate) enum StartRun {
    /// Confirm a run that waits for confirmation, optionally for a subset of targets.
    Confirm {
        run_id: String,
        targets: Option<Vec<String>>,
    },
    /// Run a rule for a commit without pushing first.
    Manual {
        rule_id: String,
        source_branch: String,
        source_oid: String,
        targets: Option<Vec<String>>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunAction {
    Resume,
    SkipTarget,
    Stop,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PipelineStepDto {
    position: u32,
    target_branch: String,
    remote: String,
    state: &'static str,
    lease_oid: Option<String>,
    merge_oid: Option<String>,
    repo_context: Option<String>,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PipelineRunDto {
    run_id: String,
    repo_id: String,
    rule_id: String,
    rule_name: String,
    source_branch: String,
    source_oid: String,
    execution_mode: &'static str,
    status: &'static str,
    shelf_id: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    steps: Vec<PipelineStepDto>,
}

impl From<&PipelineRun> for PipelineRunDto {
    fn from(run: &PipelineRun) -> Self {
        Self {
            run_id: run.run_id.clone(),
            repo_id: run.repo_id.clone(),
            rule_id: run.rule.rule_id.clone(),
            rule_name: run.rule.name.clone(),
            source_branch: run.source_branch.clone(),
            source_oid: run.source_oid.clone(),
            execution_mode: run.execution_mode.as_str(),
            status: run.status.as_str(),
            shelf_id: run.shelf_id.clone(),
            created_at_ms: run.created_at_ms,
            updated_at_ms: run.updated_at_ms,
            steps: run
                .steps
                .iter()
                .map(|step| PipelineStepDto {
                    position: step.position,
                    target_branch: step.target_branch.clone(),
                    remote: step.remote.clone(),
                    state: step.state.as_str(),
                    lease_oid: step.lease_oid.clone(),
                    merge_oid: step.merge_oid.clone(),
                    repo_context: step.ephemeral_repo_id.clone(),
                    message: step.message.clone(),
                })
                .collect(),
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

pub(crate) struct PipelineService {
    store: Arc<dyn PipelineStorePort>,
    engine: Arc<Engine>,
    events: EventBus,
    contexts: Arc<EphemeralContexts>,
    counter: AtomicU64,
}

impl PipelineService {
    pub(crate) fn new(
        store: Arc<dyn PipelineStorePort>,
        catalog: Arc<dyn RepositoryCatalogPort>,
        contexts: Arc<EphemeralContexts>,
        events: EventBus,
        data_dir: PathBuf,
    ) -> Self {
        let paths_catalog = catalog;
        let workspace = ModeWorkspace {
            worktree: WorktreeWorkspace::new(
                data_dir,
                Arc::new(move |repo_id| {
                    paths_catalog
                        .get(repo_id)
                        .ok()
                        .flatten()
                        .map(|record| PathBuf::from(record.path))
                }),
                contexts.clone(),
            ),
        };
        let observer_events = events.clone();
        let engine = PipelineEngine::new(store.clone(), Arc::new(workspace)).with_observer(
            Arc::new(move |run: &PipelineRun| {
                observer_events.publish(
                    Some(run.repo_id.clone()),
                    "pipeline.run.updated",
                    serde_json::to_value(PipelineRunDto::from(run)).unwrap_or_default(),
                );
            }),
        );
        Self {
            store,
            engine: Arc::new(engine),
            events,
            contexts,
            counter: AtomicU64::new(0),
        }
    }

    pub(crate) fn contexts(&self) -> &Arc<EphemeralContexts> {
        &self.contexts
    }

    fn worktree(&self) -> &WorktreeWorkspace {
        self.engine.workspace().worktree()
    }

    fn next_run_id(&self) -> String {
        let sequence = self.counter.fetch_add(1, Ordering::Relaxed);
        format!("run_{:x}{:04x}", now_ms(), sequence & 0xffff)
    }

    fn settings_for(&self, repo_id: &str) -> Result<ExecutionMode, PipelineServiceError> {
        let app = self.store.pipeline_app_settings()?;
        let repository = self.store.pipeline_repository_settings(repo_id)?;
        Ok(app.resolve(repository).execution_mode)
    }

    fn drive_in_background(&self, run_id: String) {
        let engine = self.engine.clone();
        tokio::spawn(async move {
            let _ = engine.drive(&run_id).await;
        });
    }

    /// Evaluates the repository's rules after a user push succeeded. Failures
    /// here never affect the push that triggered them.
    pub(crate) async fn on_push_succeeded(&self, push: PushedBranch, origin: PushOrigin) {
        let Ok(rules) = self.store.list_pipeline_rules(&push.repo_id) else {
            return;
        };
        let Ok(mode) = self.settings_for(&push.repo_id) else {
            return;
        };
        for rule in triggered_rules(&rules, &push.branch, origin) {
            let run_id = self.next_run_id();
            let created = self
                .engine
                .create_run(NewRun {
                    run_id: run_id.clone(),
                    repo_id: push.repo_id.clone(),
                    rule: rule.clone(),
                    source_branch: push.branch.clone(),
                    source_oid: push.oid.clone(),
                    execution_mode: mode,
                    hold: false,
                    now_ms: now_ms(),
                })
                .await;
            let Ok(run) = created else { continue };
            if run.status == RunStatus::Running {
                self.drive_in_background(run_id);
            } else {
                self.events.publish(
                    Some(run.repo_id.clone()),
                    "pipeline.trigger.pending",
                    serde_json::json!({
                        "runId": run.run_id,
                        "ruleId": run.rule.rule_id,
                        "ruleName": run.rule.name,
                        "sourceBranch": run.source_branch,
                        "targets": run.steps.iter().map(|s| s.target_branch.clone()).collect::<Vec<_>>(),
                        "protectedTarget": run.rule.has_protected_target(),
                    }),
                );
            }
        }
    }

    pub(crate) async fn start_run(
        &self,
        repo_id: &str,
        request: StartRun,
    ) -> Result<PipelineRunDto, PipelineServiceError> {
        let (run_id, targets) = match request {
            StartRun::Confirm { run_id, targets } => {
                let run = self.owned_run(repo_id, &run_id)?;
                (run.run_id, targets)
            }
            StartRun::Manual {
                rule_id,
                source_branch,
                source_oid,
                targets,
            } => {
                let rule = self
                    .store
                    .list_pipeline_rules(repo_id)?
                    .into_iter()
                    .find(|rule| rule.rule_id == rule_id)
                    .ok_or(PipelineServiceError::RuleNotFound)?;
                if source_oid.len() != 40 || !source_oid.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err(PipelineServiceError::Invalid(
                        "sourceOid must be a full 40-character commit id.".into(),
                    ));
                }
                let run = self
                    .engine
                    .create_run(NewRun {
                        run_id: self.next_run_id(),
                        repo_id: repo_id.to_owned(),
                        rule,
                        source_branch,
                        source_oid,
                        execution_mode: self.settings_for(repo_id)?,
                        hold: true,
                        now_ms: now_ms(),
                    })
                    .await?;
                (run.run_id, targets)
            }
        };
        if let Some(targets) = &targets {
            let run = self.owned_run(repo_id, &run_id)?;
            let known = |target: &String| run.steps.iter().any(|s| &s.target_branch == target);
            if targets.is_empty() || !targets.iter().all(known) {
                return Err(PipelineServiceError::Invalid(
                    "targets must name at least one target of the run.".into(),
                ));
            }
        }
        self.engine.begin_run(&run_id, targets.as_deref()).await?;
        self.drive_in_background(run_id.clone());
        self.owned_run(repo_id, &run_id).map(|run| (&run).into())
    }

    pub(crate) async fn act(
        &self,
        repo_id: &str,
        run_id: &str,
        action: RunAction,
    ) -> Result<PipelineRunDto, PipelineServiceError> {
        let run = self.owned_run(repo_id, run_id)?;
        match (action, run.status) {
            (RunAction::Resume, RunStatus::PendingConfirmation) => {
                self.engine.begin_run(run_id, None).await?;
                self.drive_in_background(run_id.to_owned());
            }
            (RunAction::Resume, RunStatus::WaitingForConflicts) => {
                let waiting = run
                    .steps
                    .iter()
                    .find(|step| step.state == StepState::WaitingForConflicts);
                if let Some(step) = waiting {
                    if run.execution_mode == ExecutionMode::TemporaryWorktree
                        && self.worktree().merge_in_progress(&run, step).await
                    {
                        return Err(PipelineServiceError::Conflict(
                            "The conflicts of this target are not resolved yet.".into(),
                        ));
                    }
                }
                self.engine
                    .resume(run_id, ResumeAction::ConflictsResolved)
                    .await?;
            }
            (RunAction::SkipTarget, RunStatus::WaitingForConflicts) => {
                self.engine.resume(run_id, ResumeAction::SkipTarget).await?;
            }
            (RunAction::Stop, RunStatus::WaitingForConflicts) => {
                self.engine.resume(run_id, ResumeAction::Stop).await?;
            }
            _ => return Err(EngineError::InvalidState.into()),
        }
        self.owned_run(repo_id, run_id).map(|run| (&run).into())
    }

    pub(crate) fn list_runs(
        &self,
        repo_id: &str,
        limit: u32,
    ) -> Result<Vec<PipelineRunDto>, PipelineServiceError> {
        Ok(self
            .store
            .list_pipeline_runs(repo_id, limit)?
            .iter()
            .map(PipelineRunDto::from)
            .collect())
    }

    pub(crate) fn run(
        &self,
        repo_id: &str,
        run_id: &str,
    ) -> Result<PipelineRunDto, PipelineServiceError> {
        self.owned_run(repo_id, run_id).map(|run| (&run).into())
    }

    fn owned_run(&self, repo_id: &str, run_id: &str) -> Result<PipelineRun, PipelineServiceError> {
        match self.store.pipeline_run(run_id)? {
            Some(run) if run.repo_id == repo_id => Ok(run),
            _ => Err(PipelineServiceError::RunNotFound),
        }
    }
}
