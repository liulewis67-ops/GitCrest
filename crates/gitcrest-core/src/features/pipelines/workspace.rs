use std::future::Future;

use crate::domain::pipeline::{PipelineRun, PipelineStep};

/// Starts the message of a step that failed because its temporary worktree could not be
/// created or used. The UI then offers to run the target in place instead.
pub(crate) const WORKSPACE_FAILURE_PREFIX: &str = "Pipeline worktree unavailable: ";

/// Why a step could not make progress. The message is shown in the Task Center.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PipelineStepError {
    pub message: String,
}

impl PipelineStepError {
    /// The worktree could not be created or used; never falls back silently to another mode.
    pub(crate) fn workspace(message: impl std::fmt::Display) -> Self {
        Self::new(format!("{WORKSPACE_FAILURE_PREFIX}{message}"))
    }

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
    /// The user chose to leave things as they are (in place: stay on the branch).
    Stay,
}

/// What a step left behind when GitCrest closed in the middle of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryFinding {
    /// A merge waits to be concluded.
    MergeInProgress,
    /// The merge commit exists but was not pushed.
    MergedNotPushed,
    /// Nothing of the merge happened yet; the step can start over.
    NotMerged,
    /// In place only: the user was left on the target branch with no merge.
    LeftOnTarget,
    /// The worktree or its state is gone.
    WorkspaceLost,
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

    /// Called once before the first step. Returns the id of anything it set aside
    /// for the run (the shelf that holds the user's uncommitted work).
    fn begin_run(
        &self,
        _run: &PipelineRun,
    ) -> impl Future<Output = Result<Option<String>, PipelineStepError>> + Send {
        async { Ok(None) }
    }

    /// Called once after the last step, whatever the outcome: puts back what
    /// `begin_run` set aside.
    fn end_run(
        &self,
        _run: &PipelineRun,
    ) -> impl Future<Output = Result<(), PipelineStepError>> + Send {
        async { Ok(()) }
    }

    /// Looks at what a step left behind after a restart, and re-registers anything the
    /// running app held in memory (the hidden context of a pipeline worktree).
    fn inspect(
        &self,
        _run: &PipelineRun,
        _step: &PipelineStep,
    ) -> impl Future<Output = RecoveryFinding> + Send {
        async { RecoveryFinding::NotMerged }
    }

    /// Release the step: remove the worktree, or return to the source branch.
    fn finish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
        outcome: StepOutcome,
    ) -> impl Future<Output = Result<(), PipelineStepError>> + Send;
}
