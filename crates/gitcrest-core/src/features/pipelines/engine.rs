use std::sync::Arc;

use tokio::sync::Mutex;

use crate::{
    domain::{
        error::RepositoryError,
        pipeline::{
            AfterConflictResolved, Confirmation, ConflictPolicy, ExecutionMode, PipelineRule,
            PipelineRuleError, PipelineRun, PipelineStep, RunStatus, StepState,
        },
    },
    ports::pipelines::PipelineStorePort,
};

use super::workspace::{
    MergeOutcome, PipelineStepError, PipelineWorkspace, PublishOutcome, StepOutcome,
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
    if origin == PushOrigin::Pipeline {
        return Vec::new();
    }
    rules
        .iter()
        .filter(|rule| rule.enabled && rule.trigger.matches_branch(branch))
        .collect()
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
    pub now_ms: i64,
}

pub(crate) struct PipelineEngine<S, W> {
    store: Arc<S>,
    workspace: Arc<W>,
    /// Serializes "is a run active" checks with the writes that follow them.
    gate: Mutex<()>,
}

impl<S: PipelineStorePort, W: PipelineWorkspace> PipelineEngine<S, W> {
    pub(crate) fn new(store: Arc<S>, workspace: Arc<W>) -> Self {
        Self {
            store,
            workspace,
            gate: Mutex::new(()),
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
        let status = if rule.confirmation == Confirmation::Ask || !active.is_empty() {
            RunStatus::PendingConfirmation
        } else {
            RunStatus::Running
        };
        let steps = rule
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
        Ok(run)
    }

    /// Confirms a pending run and drives it until it finishes or waits for the user.
    pub(crate) async fn start_run(&self, run_id: &str) -> Result<RunStatus, EngineError> {
        {
            let _gate = self.gate.lock().await;
            let run = self.load(run_id)?;
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
            self.store
                .update_pipeline_run(run_id, RunStatus::Running, run.shelf_id.as_deref())?;
        }
        self.drive(run_id).await
    }

    /// Runs the remaining steps of a `Running` run.
    pub(crate) async fn drive(&self, run_id: &str) -> Result<RunStatus, EngineError> {
        loop {
            let mut run = self.load(run_id)?;
            if run.status != RunStatus::Running {
                return Ok(run.status);
            }
            let Some(index) = run.steps.iter().position(|s| !s.state.is_terminal()) else {
                return self.finalize(&run);
            };
            if run.steps[index].state == StepState::WaitingForConflicts {
                self.set_run_status(&mut run, RunStatus::WaitingForConflicts)?;
                return Ok(run.status);
            }
            match self.run_step(&mut run, index, Phase::Prepare).await? {
                StepFlow::Continue => {}
                StepFlow::Paused => return Ok(RunStatus::WaitingForConflicts),
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
                self.skip_remaining(&mut run, "Not run: the pipeline was stopped")?;
                self.set_run_status(&mut run, RunStatus::Cancelled)?;
                return Ok(run.status);
            }
        }
        self.drive(run_id).await
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
                        RunStatus::Running | RunStatus::WaitingForConflicts
                    )
            })
            .collect())
    }

    fn set_run_status(&self, run: &mut PipelineRun, status: RunStatus) -> Result<(), EngineError> {
        self.store
            .update_pipeline_run(&run.run_id, status, run.shelf_id.as_deref())?;
        run.status = status;
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

    fn finalize(&self, run: &PipelineRun) -> Result<RunStatus, EngineError> {
        let status = run.final_status().unwrap_or(RunStatus::Failed);
        self.store
            .update_pipeline_run(&run.run_id, status, run.shelf_id.as_deref())?;
        Ok(status)
    }

    async fn run_step(
        &self,
        run: &mut PipelineRun,
        index: usize,
        start: Phase,
    ) -> Result<StepFlow, EngineError> {
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
                    self.release(run, index, StepOutcome::Retry).await;
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
                self.set_step(run, index, StepState::WaitingForConflicts, None)?;
                self.set_run_status(run, RunStatus::WaitingForConflicts)?;
                Ok(StepFlow::Paused)
            }
            ConflictPolicy::SkipTarget => {
                self.abort_and_end(run, index, StepState::Skipped, "Skipped after conflicts")
                    .await?;
                Ok(StepFlow::Continue)
            }
            ConflictPolicy::StopRun => {
                self.abort_and_end(run, index, StepState::Failed, "Stopped after conflicts")
                    .await?;
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
        if let Err(error) = self.workspace.abort_merge(run, &run.steps[index]).await {
            message = format!("{message}; aborting the merge failed: {}", error.message);
        }
        self.set_step(run, index, state, Some(message))?;
        let outcome = match state {
            StepState::Failed => StepOutcome::Failed,
            _ => StepOutcome::Skipped,
        };
        self.release(run, index, outcome).await;
        Ok(())
    }

    async fn finish_step(
        &self,
        run: &mut PipelineRun,
        index: usize,
        state: StepState,
        outcome: StepOutcome,
    ) -> Result<(), EngineError> {
        self.set_step(run, index, StepState::Finishing, None)?;
        let cleanup = self.workspace.finish(run, &run.steps[index], outcome).await;
        let message = cleanup
            .err()
            .map(|error| format!("Cleanup failed: {}", error.message));
        self.set_step(run, index, state, message)
    }

    async fn fail_step(
        &self,
        run: &mut PipelineRun,
        index: usize,
        error: PipelineStepError,
    ) -> Result<StepFlow, EngineError> {
        self.release(run, index, StepOutcome::Failed).await;
        self.set_step(run, index, StepState::Failed, Some(error.message))?;
        let target = run.steps[index].target_branch.clone();
        self.skip_remaining(run, &format!("Not run: {target} failed"))?;
        Ok(StepFlow::Continue)
    }

    /// Best-effort workspace release; the step outcome is already decided.
    async fn release(&self, run: &PipelineRun, index: usize, outcome: StepOutcome) {
        let _ = self.workspace.finish(run, &run.steps[index], outcome).await;
    }
}

#[cfg(test)]
mod tests;
