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
    execution::TaskFailure,
    features::{repositories::RepositoryTargetReader, tasks::TaskService},
};

use crate::{
    domain::{
        error::RepositoryError,
        pipeline::{ExecutionMode, PipelineRun, PipelineStep, RunStatus, StepState},
    },
    events::publisher::EventBus,
    ports::{pipelines::PipelineStorePort, repository::RepositoryCatalogPort},
};

use super::{
    engine::{
        triggered_rules, EngineError, NewRun, PipelineEngine, PushOrigin, RecoveryProposal,
        ResumeAction,
    },
    ephemeral::EphemeralContexts,
    inplace::InPlaceWorkspace,
    workspace::{
        MergeOutcome, PipelineStepError, PipelineWorkspace, PreparedStep, PublishOutcome,
        RecoveryFinding, StepOutcome, WORKSPACE_FAILURE_PREFIX,
    },
    worktree::WorktreeWorkspace,
};

/// Picks the workspace by the execution mode the run started with.
pub(crate) struct ModeWorkspace {
    worktree: WorktreeWorkspace,
    in_place: InPlaceWorkspace,
}

impl ModeWorkspace {
    pub(crate) async fn merge_in_progress(&self, run: &PipelineRun, step: &PipelineStep) -> bool {
        match run.execution_mode {
            ExecutionMode::TemporaryWorktree => self.worktree.merge_in_progress(run, step).await,
            ExecutionMode::SwitchInPlace => self.in_place.merge_in_progress(run).await,
        }
    }

    pub(crate) fn worktree(&self) -> &WorktreeWorkspace {
        &self.worktree
    }

    pub(crate) fn in_place(&self) -> &InPlaceWorkspace {
        &self.in_place
    }
}

macro_rules! dispatch {
    ($self:ident, $run:ident, $method:ident($($arg:expr),*)) => {
        match $run.execution_mode {
            ExecutionMode::TemporaryWorktree => $self.worktree.$method($($arg),*).await,
            ExecutionMode::SwitchInPlace => $self.in_place.$method($($arg),*).await,
        }
    };
}

impl PipelineWorkspace for ModeWorkspace {
    async fn begin_run(&self, run: &PipelineRun) -> Result<Option<String>, PipelineStepError> {
        dispatch!(self, run, begin_run(run))
    }

    async fn end_run(&self, run: &PipelineRun) -> Result<(), PipelineStepError> {
        dispatch!(self, run, end_run(run))
    }

    async fn prepare(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PreparedStep, PipelineStepError> {
        dispatch!(self, run, prepare(run, step))
    }

    async fn merge(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
        message: &str,
    ) -> Result<MergeOutcome, PipelineStepError> {
        dispatch!(self, run, merge(run, step, message))
    }

    async fn abort_merge(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<(), PipelineStepError> {
        dispatch!(self, run, abort_merge(run, step))
    }

    async fn publish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PublishOutcome, PipelineStepError> {
        dispatch!(self, run, publish(run, step))
    }

    async fn inspect(&self, run: &PipelineRun, step: &PipelineStep) -> RecoveryFinding {
        match run.execution_mode {
            ExecutionMode::TemporaryWorktree => self.worktree.inspect(run, step).await,
            ExecutionMode::SwitchInPlace => self.in_place.inspect(run, step).await,
        }
    }

    async fn finish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
        outcome: StepOutcome,
    ) -> Result<(), PipelineStepError> {
        dispatch!(self, run, finish(run, step, outcome))
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
        /// For this run only; the repository setting stays as it is.
        execution_mode: Option<ExecutionMode>,
    },
}

/// How a recovery on a repository context ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryOutcome {
    Continued,
    Aborted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunAction {
    Resume,
    SkipTarget,
    Stop,
    ReturnToSource,
    Discard,
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
    /// The temporary worktree could not be created or used; running in place is an option.
    workspace_failed: bool,
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
    /// What the user can choose for an interrupted run (resumePush, restartStep, returnToSource).
    recovery: Option<&'static str>,
    /// The changes set aside for this run are still in the stash list; restore them with `git stash pop`.
    shelf_pending: bool,
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
                    workspace_failed: step.state == StepState::Failed
                        && step
                            .message
                            .as_deref()
                            .is_some_and(|message| message.starts_with(WORKSPACE_FAILURE_PREFIX)),
                })
                .collect(),
            recovery: None,
            shelf_pending: false,
        }
    }
}

type Proposals = Arc<std::sync::Mutex<std::collections::HashMap<String, RecoveryProposal>>>;
type Shelves = Arc<std::sync::Mutex<std::collections::HashSet<String>>>;

/// What the service knows about runs beyond what is stored.
#[derive(Clone, Default)]
struct Views {
    proposals: Proposals,
    shelves: Shelves,
}

fn dto_for(views: &Views, run: &PipelineRun) -> PipelineRunDto {
    let proposals = &views.proposals;
    let mut dto = PipelineRunDto::from(run);
    dto.shelf_pending = views
        .shelves
        .lock()
        .is_ok_and(|set| set.contains(&run.run_id));
    if run.status == RunStatus::Interrupted {
        dto.recovery = proposals
            .lock()
            .ok()
            .and_then(|map| map.get(&run.run_id).copied())
            .map(RecoveryProposal::as_str);
    }
    dto
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
    views: Views,
    data_dir: PathBuf,
    catalog: Arc<dyn RepositoryCatalogPort>,
    counter: AtomicU64,
}

impl PipelineService {
    #[allow(clippy::too_many_arguments)] // wired once in bootstrap; a config struct would only move the list
    pub(crate) fn new(
        store: Arc<dyn PipelineStorePort>,
        catalog: Arc<dyn RepositoryCatalogPort>,
        contexts: Arc<EphemeralContexts>,
        events: EventBus,
        data_dir: PathBuf,
        tasks: TaskService,
        targets: RepositoryTargetReader,
        git: crate::git::command::GitCommandService,
    ) -> Self {
        let paths_catalog = catalog.clone();
        let views = Views::default();
        let observer_views = views.clone();
        let data_dir_copy = data_dir.clone();
        let in_place_catalog = paths_catalog.clone();
        let policy_store = store.clone();
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
            )
            .with_credentials(git.clone()),
            in_place: InPlaceWorkspace::new(
                Arc::new(move |repo_id| {
                    in_place_catalog
                        .get(repo_id)
                        .ok()
                        .flatten()
                        .map(|record| PathBuf::from(record.path))
                }),
                Arc::new(move |repo_id| {
                    let app = policy_store.pipeline_app_settings().unwrap_or_default();
                    let repository = policy_store
                        .pipeline_repository_settings(repo_id)
                        .unwrap_or_default();
                    app.resolve(repository).in_place_dirty_policy
                }),
            )
            .with_credentials(git),
        };
        let observer_events = events.clone();
        let hold_store = store.clone();
        tasks.hold_repositories_when(move |repo_id| {
            hold_store
                .list_active_pipeline_runs()
                .map(|runs| {
                    runs.iter().any(|run| {
                        run.repo_id == repo_id
                            && run.execution_mode == ExecutionMode::SwitchInPlace
                            && run.status == RunStatus::Running
                    })
                })
                .unwrap_or(false)
        });
        let waiting_tasks = WaitingTasks::new(tasks, targets, contexts.clone());
        let engine = PipelineEngine::new(store.clone(), Arc::new(workspace)).with_observer(
            Arc::new(move |run: &PipelineRun| {
                observer_events.publish(
                    Some(run.repo_id.clone()),
                    "pipeline.run.updated",
                    serde_json::to_value(dto_for(&observer_views, run)).unwrap_or_default(),
                );
                waiting_tasks.sync(run);
            }),
        );
        Self {
            store,
            engine: Arc::new(engine),
            events,
            contexts,
            views,
            data_dir: data_dir_copy,
            catalog,
            counter: AtomicU64::new(0),
        }
    }

    fn proposal_of(&self, run_id: &str) -> Option<RecoveryProposal> {
        self.views.proposals.lock().ok()?.get(run_id).copied()
    }

    /// Looks at every unfinished run after a start of GitCrest: waiting conflicts are picked up
    /// again, interrupted work gets a proposal for the user, lost workspaces are failed, and
    /// worktree folders that belong to no unfinished run are removed.
    pub(crate) async fn recover_on_startup(&self) {
        let Ok(runs) = self.store.list_active_pipeline_runs() else {
            return;
        };
        for run in &runs {
            let Ok(proposal) = self.engine.recover_run(&run.run_id).await else {
                continue;
            };
            let Some(proposal) = proposal else { continue };
            if let Ok(mut proposals) = self.views.proposals.lock() {
                proposals.insert(run.run_id.clone(), proposal);
            }
            // The proposal is known only now; tell open windows about the run again.
            if let Ok(Some(current)) = self.store.pipeline_run(&run.run_id) {
                self.events.publish(
                    Some(current.repo_id.clone()),
                    "pipeline.run.updated",
                    serde_json::to_value(dto_for(&self.views, &current)).unwrap_or_default(),
                );
            }
        }
        // Finished in-place runs whose set-aside changes were never restored stay visible.
        let finished: Vec<PipelineRun> = repositories_runs(&*self.store, &*self.catalog);
        for run in finished {
            if run.status.is_terminal()
                && run.execution_mode == ExecutionMode::SwitchInPlace
                && self.engine.workspace().in_place().shelf_pending(&run).await
            {
                if let Ok(mut shelves) = self.views.shelves.lock() {
                    shelves.insert(run.run_id.clone());
                }
            }
        }
        let still_active: std::collections::HashSet<String> = self
            .store
            .list_active_pipeline_runs()
            .map(|runs| runs.into_iter().map(|run| run.run_id).collect())
            .unwrap_or_default();
        let repositories: Vec<PathBuf> = self
            .catalog
            .list()
            .map(|records| {
                records
                    .into_iter()
                    .map(|record| PathBuf::from(record.path))
                    .collect()
            })
            .unwrap_or_default();
        self.engine
            .workspace()
            .worktree()
            .sweep_orphans(&still_active, &repositories)
            .await;
        let _ = &self.data_dir;
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
                execution_mode,
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
                        execution_mode: match execution_mode {
                            Some(mode) => mode,
                            None => self.settings_for(repo_id)?,
                        },
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
        self.owned_run(repo_id, &run_id)
            .map(|run| dto_for(&self.views, &run))
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
                    if self.engine.workspace().merge_in_progress(&run, step).await {
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
            (RunAction::Resume, RunStatus::Interrupted) => {
                let push = match self.proposal_of(run_id) {
                    Some(RecoveryProposal::ResumePush) => true,
                    Some(RecoveryProposal::RestartStep) => false,
                    _ => return Err(EngineError::InvalidState.into()),
                };
                // Mark the run running before returning so a second click cannot start it twice.
                let engine = self.engine.clone();
                let id = run_id.to_owned();
                self.engine.begin_interrupted(run_id).await?;
                tokio::spawn(async move {
                    let _ = engine.continue_interrupted(&id, push).await;
                });
            }
            (RunAction::ReturnToSource, RunStatus::Interrupted) => {
                self.engine.abandon_interrupted(run_id, true).await?;
            }
            (RunAction::Discard, RunStatus::Interrupted) => {
                self.engine.abandon_interrupted(run_id, false).await?;
            }
            _ => return Err(EngineError::InvalidState.into()),
        }
        self.owned_run(repo_id, run_id)
            .map(|run| dto_for(&self.views, &run))
    }

    /// Called when a workflow recovery (continue or abort) succeeded on a repository
    /// context. If a pipeline step waits for conflicts there, a continue resumes the run
    /// and an abort asks the user whether to skip the target or stop.
    pub(crate) async fn on_workflow_recovered(&self, repo_context: &str, outcome: RecoveryOutcome) {
        let Ok(runs) = self.store.list_active_pipeline_runs() else {
            return;
        };
        let waiting = runs.iter().find_map(|run| {
            if run.status != RunStatus::WaitingForConflicts {
                return None;
            }
            run.steps
                .iter()
                .find(|step| {
                    step.state == StepState::WaitingForConflicts
                        && step.ephemeral_repo_id.as_deref() == Some(repo_context)
                })
                .map(|step| (run, step))
        });
        let Some((run, step)) = waiting else {
            return;
        };
        match outcome {
            RecoveryOutcome::Continued => {
                let engine = self.engine.clone();
                let run_id = run.run_id.clone();
                tokio::spawn(async move {
                    let _ = engine
                        .resume(&run_id, ResumeAction::ConflictsResolved)
                        .await;
                });
            }
            RecoveryOutcome::Aborted => self.events.publish(
                Some(run.repo_id.clone()),
                "pipeline.conflict.aborted",
                serde_json::json!({
                    "runId": run.run_id,
                    "position": step.position,
                    "targetBranch": step.target_branch,
                }),
            ),
        }
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
            .map(|run| dto_for(&self.views, run))
            .collect())
    }

    pub(crate) fn run(
        &self,
        repo_id: &str,
        run_id: &str,
    ) -> Result<PipelineRunDto, PipelineServiceError> {
        self.owned_run(repo_id, run_id)
            .map(|run| dto_for(&self.views, &run))
    }

    fn owned_run(&self, repo_id: &str, run_id: &str) -> Result<PipelineRun, PipelineServiceError> {
        match self.store.pipeline_run(run_id)? {
            Some(run) if run.repo_id == repo_id => Ok(run),
            _ => Err(PipelineServiceError::RunNotFound),
        }
    }
}

type OpenTasks = std::sync::Mutex<std::collections::HashMap<(String, u32), Option<String>>>;

/// A step that waits for conflicts is mirrored by a task in `waitingForInput`
/// on its repository context. That is what the conflict window auto-opens on
/// and what workflow recovery resolves, so pipeline conflicts reuse that flow.
#[derive(Clone)]
struct WaitingTasks {
    tasks: TaskService,
    targets: RepositoryTargetReader,
    contexts: Arc<EphemeralContexts>,
    open: Arc<OpenTasks>,
}

impl WaitingTasks {
    fn new(
        tasks: TaskService,
        targets: RepositoryTargetReader,
        contexts: Arc<EphemeralContexts>,
    ) -> Self {
        Self {
            tasks,
            targets,
            contexts,
            open: Arc::default(),
        }
    }

    /// Reconciles the waiting tasks with the steps of `run`.
    fn sync(&self, run: &PipelineRun) {
        for step in &run.steps {
            let key = (run.run_id.clone(), step.position);
            let waiting = step.state == StepState::WaitingForConflicts;
            let Ok(mut open) = self.open.lock() else {
                return;
            };
            if waiting && !open.contains_key(&key) {
                open.insert(key.clone(), None);
                drop(open);
                if let Some(context) = step.ephemeral_repo_id.clone() {
                    self.spawn_open(
                        key,
                        run.repo_id.clone(),
                        context,
                        step.target_branch.clone(),
                        run.execution_mode == ExecutionMode::TemporaryWorktree,
                    );
                }
            } else if !waiting {
                let task_id = open.remove(&key).flatten();
                drop(open);
                if let Some(task_id) = task_id {
                    let tasks = self.tasks.clone();
                    let succeeded = step.state.is_success();
                    tokio::spawn(async move {
                        let (status, message) = if succeeded {
                            (
                                crate::domain::task::TaskStatus::Succeeded,
                                "The pipeline target was merged.",
                            )
                        } else {
                            (
                                crate::domain::task::TaskStatus::Cancelled,
                                "The pipeline target was not merged.",
                            )
                        };
                        let _ = tasks
                            .resolve_waiting_for_input(&task_id, status, message)
                            .await;
                    });
                }
            }
        }
    }

    fn spawn_open(
        &self,
        key: (String, u32),
        repo_id: String,
        context: String,
        target: String,
        in_worktree: bool,
    ) {
        let label = in_worktree.then(|| format!("{target} · pipeline worktree"));
        let this = self.clone();
        tokio::spawn(async move {
            let resource_key = match this.contexts.resource_key(&context) {
                Some(key) => Some(key),
                None => this
                    .targets
                    .task_target(&context)
                    .await
                    .ok()
                    .map(|target| target.resource_key),
            };
            let Some(resource_key) = resource_key else {
                return;
            };
            let message = format!("Merging into {target} stopped on conflicts. Resolve them to continue the pipeline.");
            let submitted = this
                .tasks
                .submit(
                    Some(context),
                    label,
                    resource_key,
                    "merge",
                    move |_| async move { Err(TaskFailure::WaitingForInput(message)) },
                )
                .await;
            let _ = repo_id;
            if let Ok(snapshot) = submitted {
                let still_waiting = match this.open.lock() {
                    Ok(mut open) => match open.get_mut(&key) {
                        Some(slot) => {
                            *slot = Some(snapshot.task_id.clone());
                            true
                        }
                        None => false,
                    },
                    Err(_) => true,
                };
                if !still_waiting {
                    // The step ended before its waiting task was registered.
                    let _ = this
                        .tasks
                        .resolve_waiting_for_input(
                            &snapshot.task_id,
                            crate::domain::task::TaskStatus::Cancelled,
                            "The pipeline target is no longer waiting.",
                        )
                        .await;
                }
            }
        });
    }
}

fn repositories_runs(
    store: &dyn PipelineStorePort,
    catalog: &dyn RepositoryCatalogPort,
) -> Vec<PipelineRun> {
    catalog
        .list()
        .unwrap_or_default()
        .iter()
        .flat_map(|record| {
            store
                .list_pipeline_runs(&record.repo_id, 20)
                .unwrap_or_default()
        })
        .collect()
}
