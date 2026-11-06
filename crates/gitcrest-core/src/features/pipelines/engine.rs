use std::sync::Arc;

use tokio::sync::Mutex;

use crate::{
    domain::{
        error::RepositoryError,
        pipeline::{
            AfterConflictResolved, Confirmation, ConflictPolicy, ExecutionMode, HookEvent,
            PipelineRule, PipelineRuleError, PipelineRun, PipelineStep, RunStatus, StepState,
        },
    },
    ports::pipelines::PipelineStorePort,
};

use super::workspace::{
    MergeOutcome, PipelineStepError, PipelineWorkspace, PublishOutcome, RecoveryFinding,
    StepOutcome,
};

/// Who pushed. Pushes made by a pipeline run never evaluate triggers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PushOrigin {
    User,
    Pipeline,
}

/// Enabled rules whose trigger matches a pushed local branch.
pub(crate) fn triggered_rules<'a>(
    rules: &'a [PipelineRule],
    branch: &str,
    origin: PushOrigin,
) -> Vec<&'a PipelineRule> {
    triggered_rules_for_event(rules, branch, origin, HookEvent::AfterPush)
}

pub(crate) fn triggered_rules_for_event<'a>(
    rules: &'a [PipelineRule],
    branch: &str,
    origin: PushOrigin,
    event: HookEvent,
) -> Vec<&'a PipelineRule> {
    if origin == PushOrigin::Pipeline {
        return Vec::new();
    }
    rules
        .iter()
        .filter(|rule| {
            rule.enabled && rule.trigger.event() == event && rule.trigger.matches_branch(branch)
        })
        .collect()
}

/// What the user can choose for a run that was interrupted by closing GitCrest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryProposal {
    /// A merge waits in the workspace; the conflict flow takes over.
    ResumeConflicts,
    /// The merge commit exists; push it.
    ResumePush,
    /// Start the interrupted target over.
    RestartStep,
    /// In place: go back to the source branch and restore the shelf.
    ReturnToSource,
    CleanupRequired,
}

impl RecoveryProposal {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ResumeConflicts => "resumeConflicts",
            Self::ResumePush => "resumePush",
            Self::RestartStep => "restartStep",
            Self::ReturnToSource => "returnToSource",
            Self::CleanupRequired => "cleanupRequired",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResumeAction {
    ConflictsResolved,
    SkipTarget,
    Stop,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EngineError {
    Storage,
    RunNotFound,
    /// The run is not waiting for the requested action.
    InvalidState,
    /// Another run of the same repository is in progress.
    Busy,
    /// The source branch is a target of a run in progress.
    LoopGuard(String),
    InvalidRule(PipelineRuleError),
}

impl From<RepositoryError> for EngineError {
    fn from(_: RepositoryError) -> Self {
        Self::Storage
    }
}

enum StepFlow {
    Continue,
    Paused,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Prepare,
    Publish,
}

pub(crate) struct NewRun {
    pub run_id: String,
    pub repo_id: String,
    pub rule: PipelineRule,
    pub source_branch: String,
    pub source_oid: String,
    pub execution_mode: ExecutionMode,
    /// Create the run waiting for confirmation even when its rule would start at once
    /// (a manual run that the caller begins itself).
    pub hold: bool,
    pub now_ms: i64,
}

pub(crate) type RunObserver = Arc<dyn Fn(&PipelineRun) + Send + Sync>;

pub(crate) struct PipelineEngine<S: ?Sized, W> {
    store: Arc<S>,
    workspace: Arc<W>,
    observer: Option<RunObserver>,
    /// Serializes "is a run active" checks with the writes that follow them.
    gate: Mutex<()>,
}

impl<S: PipelineStorePort + ?Sized, W: PipelineWorkspace> PipelineEngine<S, W> {
    pub(crate) fn new(store: Arc<S>, workspace: Arc<W>) -> Self {
        Self {
            store,
            workspace,
            observer: None,
            gate: Mutex::new(()),
        }
    }

    pub(crate) fn workspace(&self) -> &W {
        &self.workspace
    }

    /// Called after every persisted run or step change with the current run.
    pub(crate) fn with_observer(mut self, observer: RunObserver) -> Self {
        self.observer = Some(observer);
        self
    }

    fn notify(&self, run: &PipelineRun) {
        if let Some(observer) = &self.observer {
            observer(run);
        }
    }

    /// Records a run. It starts `Running` only when the rule does not ask for
    /// confirmation and no other run of the repository is active; otherwise it
    /// waits as `PendingConfirmation`. Call [`Self::start_run`] to begin it.
    pub(crate) async fn create_run(&self, new: NewRun) -> Result<PipelineRun, EngineError> {
        let mut rule = new.rule;
        rule.validate().map_err(EngineError::InvalidRule)?;
        rule.normalize();
        let _gate = self.gate.lock().await;
        let active = self.active_runs(&new.repo_id)?;
        if active.iter().any(|run| {
            run.steps
                .iter()
                .any(|step| step.target_branch == new.source_branch)
        }) {
            return Err(EngineError::LoopGuard(new.source_branch));
        }
        let status = if new.hold || rule.confirmation == Confirmation::Ask || !active.is_empty() {
            RunStatus::PendingConfirmation
        } else {
            RunStatus::Running
        };
        let mut steps: Vec<PipelineStep> = rule
            .targets
            .iter()
            .enumerate()
            .map(|(position, target)| PipelineStep {
                run_id: new.run_id.clone(),
                position: position as u32,
                target_branch: target.branch.clone(),
                remote: target.remote.clone(),
                state: StepState::Pending,
                lease_oid: None,
                merge_oid: None,
                workspace_path: None,
                ephemeral_repo_id: None,
                message: None,
            })
            .collect();
        for (index, command) in rule.commands.iter().enumerate() {
            steps.push(PipelineStep {
                run_id: new.run_id.clone(),
                position: (rule.targets.len() + index) as u32,
                target_branch: format!("command {}: {}", index + 1, command.program),
                remote: String::new(),
                state: StepState::Pending,
                lease_oid: None,
                merge_oid: None,
                workspace_path: None,
                ephemeral_repo_id: None,
                message: Some(format!(
                    "{} {} ({}s)",
                    command.program,
                    serde_json::to_string(&command.args).unwrap_or_default(),
                    command.timeout_seconds
                )),
            });
        }
        let run = PipelineRun {
            run_id: new.run_id,
            repo_id: new.repo_id,
            rule,
            source_branch: new.source_branch,
            source_oid: new.source_oid,
            execution_mode: new.execution_mode,
            status,
            shelf_id: None,
            created_at_ms: new.now_ms,
            updated_at_ms: new.now_ms,
            steps,
        };
        self.store.insert_pipeline_run(&run)?;
        self.notify(&run);
        Ok(run)
    }

    /// Confirms a pending run and drives it until it finishes or waits for the user.
    pub(crate) async fn start_run(&self, run_id: &str) -> Result<RunStatus, EngineError> {
        self.begin_run(run_id, None).await?;
        self.drive(run_id).await
    }

    /// Moves a pending run to `Running`. Targets missing from `only` are skipped.
    pub(crate) async fn begin_run(
        &self,
        run_id: &str,
        only: Option<&[String]>,
    ) -> Result<(), EngineError> {
        let _gate = self.gate.lock().await;
        let mut run = self.load(run_id)?;
        {
            if run.status != RunStatus::PendingConfirmation {
                return Err(EngineError::InvalidState);
            }
            if self
                .active_runs(&run.repo_id)?
                .iter()
                .any(|other| other.run_id != run.run_id)
            {
                return Err(EngineError::Busy);
            }
            if let Some(only) = only {
                for index in 0..run.steps.len() {
                    if !only.contains(&run.steps[index].target_branch) {
                        self.set_step(
                            &mut run,
                            index,
                            StepState::Skipped,
                            Some("Not selected".into()),
                        )?;
                    }
                }
            }
            self.set_run_status(&mut run, RunStatus::Running)?;
        }
        Ok(())
    }

    /// Runs the remaining steps of a `Running` run.
    pub(crate) async fn drive(&self, run_id: &str) -> Result<RunStatus, EngineError> {
        loop {
            let mut run = self.load(run_id)?;
            if run.status != RunStatus::Running {
                return Ok(run.status);
            }
            if !run.rule.targets.is_empty()
                && run.shelf_id.is_none()
                && run.steps.iter().all(|s| s.state == StepState::Pending)
            {
                match self.workspace.begin_run(&run).await {
                    Ok(shelf_id) => {
                        run.shelf_id = shelf_id;
                        self.store.update_pipeline_run(
                            &run.run_id,
                            run.status,
                            run.shelf_id.as_deref(),
                        )?;
                    }
                    Err(error) => {
                        self.fail_step(&mut run, 0, error).await?;
                        if run.status == RunStatus::Interrupted {
                            return Ok(run.status);
                        }
                        let run = self.load(run_id)?;
                        return self.finalize(&run).await;
                    }
                }
            }
            let Some(index) = run.steps.iter().position(|s| !s.state.is_terminal()) else {
                return self.finalize(&run).await;
            };
            if matches!(
                run.steps[index].state,
                StepState::Finishing | StepState::CleanupRequired
            ) {
                self.set_step(&mut run, index, StepState::CleanupRequired, None)?;
                self.interrupt(&mut run)?;
                return Ok(run.status);
            }
            if run.steps[index].state == StepState::WaitingForConflicts {
                self.set_run_status(&mut run, RunStatus::WaitingForConflicts)?;
                return Ok(run.status);
            }
            match self.run_step(&mut run, index, Phase::Prepare).await? {
                StepFlow::Continue => {}
                StepFlow::Paused => return Ok(run.status),
            }
        }
    }

    pub(crate) async fn resume(
        &self,
        run_id: &str,
        action: ResumeAction,
    ) -> Result<RunStatus, EngineError> {
        let mut run = self.load(run_id)?;
        let waiting = run
            .steps
            .iter()
            .position(|step| step.state == StepState::WaitingForConflicts);
        let (RunStatus::WaitingForConflicts, Some(index)) = (run.status, waiting) else {
            return Err(EngineError::InvalidState);
        };
        self.set_run_status(&mut run, RunStatus::Running)?;
        match action {
            ResumeAction::ConflictsResolved => {
                self.run_step(&mut run, index, Phase::Publish).await?;
                let has_more = run.steps.iter().any(|s| s.state == StepState::Pending);
                if run.rule.after_conflict_resolved == AfterConflictResolved::Ask
                    && has_more
                    && run.status == RunStatus::Running
                {
                    self.set_run_status(&mut run, RunStatus::PendingConfirmation)?;
                    return Ok(run.status);
                }
            }
            ResumeAction::SkipTarget => {
                self.abort_and_end(
                    &mut run,
                    index,
                    StepState::Skipped,
                    "Skipped after conflicts",
                )
                .await?;
            }
            ResumeAction::Stop => {
                self.abort_and_end(&mut run, index, StepState::Skipped, "Stopped by the user")
                    .await?;
                if run.status == RunStatus::Interrupted {
                    return Ok(run.status);
                }
                self.skip_remaining(&mut run, "Not run: the pipeline was stopped")?;
                self.end(&mut run).await?;
                self.set_run_status(&mut run, RunStatus::Cancelled)?;
                return Ok(run.status);
            }
        }
        self.drive(run_id).await
    }

    /// Decides what an unfinished run needs after a restart. Runs whose workspace is
    /// gone are failed here; the others wait for the user (`None` when nothing is left).
    pub(crate) async fn recover_run(
        &self,
        run_id: &str,
    ) -> Result<Option<RecoveryProposal>, EngineError> {
        let mut run = self.load(run_id)?;
        if !matches!(
            run.status,
            RunStatus::Running | RunStatus::WaitingForConflicts | RunStatus::Interrupted
        ) {
            return Ok(None);
        }
        let Some(index) = run.steps.iter().position(|s| !s.state.is_terminal()) else {
            self.finalize(&run).await?;
            return Ok(None);
        };
        if matches!(
            run.steps[index].state,
            StepState::Finishing | StepState::CleanupRequired
        ) {
            self.set_step(&mut run, index, StepState::CleanupRequired, None)?;
            self.interrupt(&mut run)?;
            return Ok(Some(RecoveryProposal::CleanupRequired));
        }
        if run.steps[index].state == StepState::Pending {
            self.interrupt(&mut run)?;
            return Ok(Some(RecoveryProposal::RestartStep));
        }
        if index >= run.rule.targets.len() {
            self.interrupt(&mut run)?;
            return Ok(Some(RecoveryProposal::RestartStep));
        }
        match self.workspace.inspect(&run, &run.steps[index]).await {
            RecoveryFinding::MergeInProgress => {
                if run.steps[index].state != StepState::WaitingForConflicts {
                    self.set_step(&mut run, index, StepState::WaitingForConflicts, None)?;
                }
                self.set_run_status(&mut run, RunStatus::WaitingForConflicts)?;
                Ok(Some(RecoveryProposal::ResumeConflicts))
            }
            RecoveryFinding::MergedNotPushed => {
                self.interrupt(&mut run)?;
                Ok(Some(RecoveryProposal::ResumePush))
            }
            RecoveryFinding::NotMerged => {
                self.interrupt(&mut run)?;
                Ok(Some(RecoveryProposal::RestartStep))
            }
            RecoveryFinding::LeftOnTarget => {
                self.interrupt(&mut run)?;
                Ok(Some(RecoveryProposal::ReturnToSource))
            }
            RecoveryFinding::WorkspaceLost => {
                let error = PipelineStepError::new(
                    "The pipeline workspace was lost when GitCrest closed; run it again",
                );
                self.fail_step(&mut run, index, error).await?;
                if run.steps[index].state == StepState::CleanupRequired {
                    return Ok(Some(RecoveryProposal::CleanupRequired));
                }
                let run = self.load(run_id)?;
                self.finalize(&run).await?;
                Ok(None)
            }
        }
    }

    fn interrupt(&self, run: &mut PipelineRun) -> Result<(), EngineError> {
        if run.status != RunStatus::Interrupted {
            self.set_run_status(run, RunStatus::Interrupted)?;
        }
        Ok(())
    }

    /// Continues an interrupted run: pushes the existing merge commit, or starts the
    /// interrupted target over.
    pub(crate) async fn resume_interrupted(
        &self,
        run_id: &str,
        push: bool,
    ) -> Result<RunStatus, EngineError> {
        self.begin_interrupted(run_id).await?;
        self.continue_interrupted(run_id, push).await
    }

    /// Marks an interrupted run as running again, so a second request cannot start it twice.
    pub(crate) async fn begin_interrupted(&self, run_id: &str) -> Result<(), EngineError> {
        let _gate = self.gate.lock().await;
        let mut run = self.load(run_id)?;
        if run.status != RunStatus::Interrupted
            || run.steps.iter().all(|s| s.state.is_terminal())
            || run.steps.iter().any(|step| {
                matches!(
                    step.state,
                    StepState::CleanupRequired | StepState::Finishing
                )
            })
        {
            return Err(EngineError::InvalidState);
        }
        self.set_run_status(&mut run, RunStatus::Running)
    }

    /// Runs the interrupted step again (pushing the existing merge commit when `push`),
    /// then the remaining targets. Call after [`Self::begin_interrupted`].
    pub(crate) async fn continue_interrupted(
        &self,
        run_id: &str,
        push: bool,
    ) -> Result<RunStatus, EngineError> {
        let mut run = self.load(run_id)?;
        if run.status != RunStatus::Running
            || run.steps.iter().any(|step| {
                matches!(
                    step.state,
                    StepState::Finishing | StepState::CleanupRequired
                )
            })
        {
            return Err(EngineError::InvalidState);
        }
        let Some(index) = run.steps.iter().position(|s| !s.state.is_terminal()) else {
            return self.drive(run_id).await;
        };
        let phase = if push { Phase::Publish } else { Phase::Prepare };
        self.run_step(&mut run, index, phase).await?;
        self.drive(run_id).await
    }

    /// Ends an interrupted run without finishing its targets. `return_to_source` also
    /// puts the user back on the source branch and restores the shelf; otherwise things
    /// stay where they are.
    pub(crate) async fn abandon_interrupted(
        &self,
        run_id: &str,
        return_to_source: bool,
    ) -> Result<RunStatus, EngineError> {
        let _gate = self.gate.lock().await;
        let mut run = self.load(run_id)?;
        if run.status != RunStatus::Interrupted {
            return Err(EngineError::InvalidState);
        }
        if let Some(index) = run.steps.iter().position(|s| !s.state.is_terminal()) {
            let cleanup_required = matches!(
                run.steps[index].state,
                StepState::CleanupRequired | StepState::Finishing
            );
            if cleanup_required && !return_to_source {
                return Err(EngineError::InvalidState);
            }
            if cleanup_required {
                if let Err(error) = self.workspace.abort_merge(&run, &run.steps[index]).await {
                    self.cleanup_required(
                        &mut run,
                        index,
                        format!("Cleanup stopped: {}", error.message),
                    )?;
                    return Ok(run.status);
                }
            }
            let outcome = if return_to_source {
                StepOutcome::Skipped
            } else {
                StepOutcome::Stay
            };
            self.set_step(&mut run, index, StepState::Finishing, None)?;
            if let Err(error) = self.release(&run, index, outcome).await {
                self.cleanup_required(
                    &mut run,
                    index,
                    format!("Cleanup failed: {}", error.message),
                )?;
                return Ok(run.status);
            }
            let message = if cleanup_required {
                match run.steps[index].message.as_deref() {
                    Some(previous) => format!(
                        "{}; cleanup completed; the run was stopped",
                        previous.chars().take(4096).collect::<String>()
                    ),
                    None => "Cleanup completed; the run was stopped".into(),
                }
            } else {
                "Abandoned after GitCrest closed".into()
            };
            self.set_step(&mut run, index, StepState::Skipped, Some(message))?;
        }
        self.skip_remaining(&mut run, "Not run: the pipeline was abandoned")?;
        if return_to_source {
            self.end(&mut run).await?;
        }
        self.set_run_status(&mut run, RunStatus::Cancelled)?;
        Ok(run.status)
    }

    fn load(&self, run_id: &str) -> Result<PipelineRun, EngineError> {
        self.store
            .pipeline_run(run_id)?
            .ok_or(EngineError::RunNotFound)
    }

    fn active_runs(&self, repo_id: &str) -> Result<Vec<PipelineRun>, EngineError> {
        Ok(self
            .store
            .list_active_pipeline_runs()?
            .into_iter()
            .filter(|run| {
                run.repo_id == repo_id
                    && matches!(
                        run.status,
                        RunStatus::Running
                            | RunStatus::WaitingForConflicts
                            | RunStatus::Interrupted
                    )
            })
            .collect())
    }

    fn set_run_status(&self, run: &mut PipelineRun, status: RunStatus) -> Result<(), EngineError> {
        self.store
            .update_pipeline_run(&run.run_id, status, run.shelf_id.as_deref())?;
        run.status = status;
        self.notify(run);
        Ok(())
    }

    /// Persists the step before the Git command its new state describes.
    fn set_step(
        &self,
        run: &mut PipelineRun,
        index: usize,
        state: StepState,
        message: Option<String>,
    ) -> Result<(), EngineError> {
        let step = &mut run.steps[index];
        step.state = state;
        if message.is_some() {
            step.message = message;
        }
        self.store.update_pipeline_step(step)?;
        self.notify(run);
        Ok(())
    }

    fn skip_remaining(&self, run: &mut PipelineRun, reason: &str) -> Result<(), EngineError> {
        for index in 0..run.steps.len() {
            if run.steps[index].state == StepState::Pending {
                self.set_step(run, index, StepState::Skipped, Some(reason.into()))?;
            }
        }
        Ok(())
    }

    async fn finalize(&self, run: &PipelineRun) -> Result<RunStatus, EngineError> {
        let mut run = run.clone();
        self.end(&mut run).await?;
        let run = &run;
        let status = run.final_status().unwrap_or(RunStatus::Failed);
        self.store
            .update_pipeline_run(&run.run_id, status, run.shelf_id.as_deref())?;
        let mut finished = run.clone();
        finished.status = status;
        self.notify(&finished);
        Ok(status)
    }

    /// Gives back what `begin_run` set aside; a failure is reported on the last step.
    async fn end(&self, run: &mut PipelineRun) -> Result<(), EngineError> {
        if run.rule.targets.is_empty() {
            return Ok(());
        }
        if let Err(error) = self.workspace.end_run(run).await {
            let last = run.steps.len() - 1;
            let message = match run.steps[last].message.take() {
                Some(existing) => format!("{existing}; {}", error.message),
                None => error.message,
            };
            let state = run.steps[last].state;
            self.set_step(run, last, state, Some(message))?;
        }
        Ok(())
    }

    async fn run_step(
        &self,
        run: &mut PipelineRun,
        index: usize,
        start: Phase,
    ) -> Result<StepFlow, EngineError> {
        if index >= run.rule.targets.len() {
            self.set_step(run, index, StepState::Preparing, None)?;
            let command = &run.rule.commands[index - run.rule.targets.len()];
            match self.workspace.execute_command(run, command).await {
                Ok(message) => self.set_step(run, index, StepState::Done, Some(message))?,
                Err(error) => {
                    self.set_step(run, index, StepState::Failed, Some(error.message))?;
                    self.skip_remaining(run, "Not run: a hook command failed")?;
                }
            }
            return Ok(StepFlow::Continue);
        }
        let mut phase = start;
        let mut attempt = 0;
        loop {
            if phase == Phase::Prepare {
                self.set_step(run, index, StepState::Preparing, None)?;
                let prepared = match self.workspace.prepare(run, &run.steps[index]).await {
                    Ok(prepared) => prepared,
                    Err(error) => return self.fail_step(run, index, error).await,
                };
                let step = &mut run.steps[index];
                step.lease_oid = Some(prepared.lease_oid);
                step.workspace_path = prepared.workspace_path;
                step.ephemeral_repo_id = Some(prepared.repo_context);
                self.set_step(run, index, StepState::Merging, None)?;
                let message = run.rule.render_commit_message(
                    &run.source_branch,
                    &run.steps[index].target_branch,
                    &run.source_oid,
                );
                match self.workspace.merge(run, &run.steps[index], &message).await {
                    Err(error) => return self.fail_step(run, index, error).await,
                    Ok(MergeOutcome::UpToDate) => {
                        self.finish_step(run, index, StepState::UpToDate, StepOutcome::UpToDate)
                            .await?;
                        return Ok(StepFlow::Continue);
                    }
                    Ok(MergeOutcome::Conflicts) => return self.on_conflicts(run, index).await,
                    Ok(MergeOutcome::Merged { oid }) => {
                        run.steps[index].merge_oid = Some(oid);
                    }
                }
            }
            if !run.rule.push_after_merge {
                self.finish_step(run, index, StepState::Done, StepOutcome::Done)
                    .await?;
                return Ok(StepFlow::Continue);
            }
            self.set_step(run, index, StepState::Pushing, None)?;
            match self.workspace.publish(run, &run.steps[index]).await {
                Err(error) => return self.fail_step(run, index, error).await,
                Ok(PublishOutcome::Pushed) => {
                    self.finish_step(run, index, StepState::Done, StepOutcome::Done)
                        .await?;
                    return Ok(StepFlow::Continue);
                }
                Ok(PublishOutcome::LeaseRejected) if attempt == 0 => {
                    attempt += 1;
                    self.set_step(run, index, StepState::Finishing, None)?;
                    if let Err(error) = self.release(run, index, StepOutcome::Retry).await {
                        self.cleanup_required(
                            run,
                            index,
                            format!(
                                "Remote changed; cleanup before retry failed: {}",
                                error.message
                            ),
                        )?;
                        return Ok(StepFlow::Paused);
                    }
                    phase = Phase::Prepare;
                }
                Ok(PublishOutcome::LeaseRejected) => {
                    let message = format!(
                        "{} changed on the remote twice while merging; run again",
                        run.steps[index].target_branch
                    );
                    return self
                        .fail_step(run, index, PipelineStepError::new(message))
                        .await;
                }
            }
        }
    }

    async fn on_conflicts(
        &self,
        run: &mut PipelineRun,
        index: usize,
    ) -> Result<StepFlow, EngineError> {
        match run.rule.on_conflict {
            ConflictPolicy::OpenResolver => {
                // The run stops holding the working tree before its waiting task is announced.
                self.set_run_status(run, RunStatus::WaitingForConflicts)?;
                self.set_step(run, index, StepState::WaitingForConflicts, None)?;
                Ok(StepFlow::Paused)
            }
            ConflictPolicy::SkipTarget => {
                self.abort_and_end(run, index, StepState::Skipped, "Skipped after conflicts")
                    .await?;
                Ok(if run.status == RunStatus::Interrupted {
                    StepFlow::Paused
                } else {
                    StepFlow::Continue
                })
            }
            ConflictPolicy::StopRun => {
                self.abort_and_end(run, index, StepState::Failed, "Stopped after conflicts")
                    .await?;
                if run.status == RunStatus::Interrupted {
                    return Ok(StepFlow::Paused);
                }
                self.skip_remaining(run, "Not run: the pipeline stopped after conflicts")?;
                Ok(StepFlow::Continue)
            }
        }
    }

    async fn abort_and_end(
        &self,
        run: &mut PipelineRun,
        index: usize,
        state: StepState,
        message: &str,
    ) -> Result<(), EngineError> {
        let mut message = message.to_string();
        self.set_step(run, index, StepState::Finishing, Some(message.clone()))?;
        if let Err(error) = self.workspace.abort_merge(run, &run.steps[index]).await {
            message = format!("{message}; aborting the merge failed: {}", error.message);
            self.cleanup_required(run, index, message)?;
            return Ok(());
        }
        self.set_step(run, index, StepState::Finishing, Some(message.clone()))?;
        let outcome = match state {
            StepState::Failed => StepOutcome::Failed,
            _ => StepOutcome::Skipped,
        };
        if let Err(error) = self.release(run, index, outcome).await {
            self.cleanup_required(
                run,
                index,
                format!("{message}; cleanup failed: {}", error.message),
            )?;
            return Ok(());
        }
        self.set_step(run, index, state, Some(message))
    }

    async fn finish_step(
        &self,
        run: &mut PipelineRun,
        index: usize,
        state: StepState,
        outcome: StepOutcome,
    ) -> Result<(), EngineError> {
        self.set_step(run, index, StepState::Finishing, None)?;
        let cleanup = self.release(run, index, outcome).await;
        if let Err(error) = &cleanup {
            self.cleanup_required(run, index, format!("Cleanup failed: {}", error.message))?;
            return Ok(());
        }
        self.set_step(run, index, state, None)
    }

    async fn fail_step(
        &self,
        run: &mut PipelineRun,
        index: usize,
        error: PipelineStepError,
    ) -> Result<StepFlow, EngineError> {
        self.set_step(
            run,
            index,
            StepState::Finishing,
            Some(error.message.clone()),
        )?;
        if let Err(cleanup) = self.release(run, index, StepOutcome::Failed).await {
            self.cleanup_required(
                run,
                index,
                format!("{}; cleanup failed: {}", error.message, cleanup.message),
            )?;
            return Ok(StepFlow::Paused);
        }
        self.set_step(run, index, StepState::Failed, Some(error.message))?;
        let target = run.steps[index].target_branch.clone();
        self.skip_remaining(run, &format!("Not run: {target} failed"))?;
        Ok(StepFlow::Continue)
    }

    fn cleanup_required(
        &self,
        run: &mut PipelineRun,
        index: usize,
        message: String,
    ) -> Result<(), EngineError> {
        let message = match run.steps[index].message.as_deref() {
            Some(previous) if !message.starts_with(previous) => format!(
                "{}; {}",
                previous.chars().take(4096).collect::<String>(),
                message.chars().take(4096).collect::<String>()
            ),
            _ => message.chars().take(8192).collect(),
        };
        self.set_step(run, index, StepState::CleanupRequired, Some(message))?;
        self.interrupt(run)
    }

    async fn release(
        &self,
        run: &PipelineRun,
        index: usize,
        outcome: StepOutcome,
    ) -> Result<(), PipelineStepError> {
        if index >= run.rule.targets.len() {
            return Ok(());
        }
        self.workspace.finish(run, &run.steps[index], outcome).await
    }
}

#[cfg(test)]
mod tests;
