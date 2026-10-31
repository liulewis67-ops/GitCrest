use std::future::Future;

use crate::domain::pipeline::{PipelineRun, PipelineStep};

/// Why a step could not make progress. The message is shown in the Task Center.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PipelineStepError {
    pub message: String,
}

impl PipelineStepError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// What `prepare` produced: the remote oid the later push is leased against,
/// and where the step's Git work happens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreparedStep {
    pub lease_oid: String,
    pub workspace_path: Option<String>,
    /// RepoId whose conflict window and recovery routes serve this step.
    pub repo_context: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum MergeOutcome {
    /// The pushed commit is already part of the target; nothing to merge or push.
    UpToDate,
    Merged {
        oid: String,
    },
    Conflicts,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PublishOutcome {
    Pushed,
    /// The remote target moved after the fetch taken in `prepare`.
    LeaseRejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StepOutcome {
    Done,
    UpToDate,
    Skipped,
    Failed,
    /// The step is about to be prepared again after a rejected lease.
    Retry,
}

/// Where a step does its Git work. The engine owns the state machine; a
/// workspace only performs the Git side effects of one step at a time.
pub(crate) trait PipelineWorkspace: Send + Sync {
    /// Produce a tree with the target at the latest remote state.
    fn prepare(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> impl Future<Output = Result<PreparedStep, PipelineStepError>> + Send;

    /// Merge the run's source commit into the prepared target.
    fn merge(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
        message: &str,
    ) -> impl Future<Output = Result<MergeOutcome, PipelineStepError>> + Send;

    /// Abort a merge that stopped on conflicts.
    fn abort_merge(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> impl Future<Output = Result<(), PipelineStepError>> + Send;

    /// Push the merged target with the lease taken in `prepare`.
    fn publish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> impl Future<Output = Result<PublishOutcome, PipelineStepError>> + Send;

    /// Release the step: remove the worktree, or return to the source branch.
    fn finish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
        outcome: StepOutcome,
    ) -> impl Future<Output = Result<(), PipelineStepError>> + Send;
}
