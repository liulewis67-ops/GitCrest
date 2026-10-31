use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
};

use crate::domain::pipeline::{PipelineRun, PipelineStep};

use super::{
    ephemeral::{context_id, EphemeralContexts},
    gitops::GitRunner,
    workspace::{
        MergeOutcome, PipelineStepError, PipelineWorkspace, PreparedStep, PublishOutcome,
        RecoveryFinding, StepOutcome,
    },
};

pub(super) type RepositoryPaths = dyn Fn(&str) -> Option<PathBuf> + Send + Sync;

/// Runs every step in a temporary detached linked worktree under the app data
/// directory, so the user's working tree and current branch are never touched.
pub(crate) struct WorktreeWorkspace {
    git: GitRunner,
    data_dir: PathBuf,
    repository_paths: Arc<RepositoryPaths>,
    contexts: Arc<EphemeralContexts>,
}

impl WorktreeWorkspace {
    pub(crate) fn new(
        data_dir: PathBuf,
        repository_paths: Arc<RepositoryPaths>,
        contexts: Arc<EphemeralContexts>,
    ) -> Self {
        Self {
            git: GitRunner::new(),
            data_dir,
            repository_paths,
            contexts,
        }
    }

    /// Environment for commands that talk to a remote (credential helpers).
    pub(crate) fn with_network_environment(
        mut self,
        environment: Vec<(OsString, OsString)>,
    ) -> Self {
        self.git = self.git.with_network_environment(environment);
        self
    }

    pub(crate) fn run_dir(&self, run_id: &str) -> PathBuf {
        self.data_dir.join("pipelines").join(run_id)
    }

    fn step_dir(&self, run: &PipelineRun, step: &PipelineStep) -> PathBuf {
        self.run_dir(&run.run_id).join(step.position.to_string())
    }

    fn repository(&self, run: &PipelineRun) -> Result<PathBuf, PipelineStepError> {
        (self.repository_paths)(&run.repo_id)
            .ok_or_else(|| PipelineStepError::new("The repository is no longer available"))
    }

    /// The local branch can only follow the push when nothing has it checked out.
    async fn fast_forward_local_branch(
        &self,
        repository: &Path,
        branch: &str,
        new_oid: &str,
    ) -> Result<(), PipelineStepError> {
        let reference = format!("refs/heads/{branch}");
        let local = self
            .git
            .git(
                repository,
                &["rev-parse", "--verify", "-q", &reference],
                false,
            )
            .await?;
        if !local.success {
            return Ok(());
        }
        let ancestor = self
            .git
            .git(
                repository,
                &["merge-base", "--is-ancestor", &local.stdout, new_oid],
                false,
            )
            .await?;
        if !ancestor.success {
            return Ok(());
        }
        let worktrees = self
            .git
            .git(repository, &["worktree", "list", "--porcelain"], false)
            .await?;
        let checked_out = worktrees
            .stdout
            .lines()
            .any(|line| line.strip_prefix("branch ") == Some(reference.as_str()));
        if checked_out {
            return Ok(());
        }
        self.git
            .git_ok(
                repository,
                &["update-ref", &reference, new_oid, &local.stdout],
                false,
                "Updating the local branch",
            )
            .await
            .map(|_| ())
    }

    /// True while the step's worktree still has a merge waiting to be concluded.
    pub(crate) async fn merge_in_progress(&self, run: &PipelineRun, step: &PipelineStep) -> bool {
        self.git.merge_in_progress(&self.step_dir(run, step)).await
    }

    /// Removes pipeline worktree directories that belong to no unfinished run,
    /// then prunes the stale registrations from each repository.
    pub(crate) async fn sweep_orphans(
        &self,
        active_run_ids: &HashSet<String>,
        repositories: &[PathBuf],
    ) {
        let root = self.data_dir.join("pipelines");
        if let Ok(mut entries) = tokio::fs::read_dir(&root).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !active_run_ids.contains(&name) {
                    let _ = tokio::fs::remove_dir_all(entry.path()).await;
                }
            }
        }
        for repository in repositories {
            let _ = self
                .git
                .git(repository, &["worktree", "prune"], false)
                .await;
        }
    }
}

impl PipelineWorkspace for WorktreeWorkspace {
    async fn prepare(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PreparedStep, PipelineStepError> {
        let repository = self.repository(run)?;
        let lease_oid = self.git.fetch_lease(&repository, step).await?;

        let directory = self.step_dir(run, step);
        if directory.exists() {
            let _ = tokio::fs::remove_dir_all(&directory).await;
            let _ = self
                .git
                .git(&repository, &["worktree", "prune"], false)
                .await;
        }
        if let Some(parent) = directory.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|_| PipelineStepError::workspace("the folder could not be created"))?;
        }
        let path = directory.to_string_lossy().into_owned();
        self.git
            .git_ok(
                &repository,
                &["worktree", "add", "--detach", "--", &path, &lease_oid],
                false,
                "Creating the pipeline worktree",
            )
            .await
            .map_err(|error| PipelineStepError::workspace(error.message))?;

        let repo_context = context_id(&run.run_id, step.position);
        self.contexts.register(&repo_context, &directory);
        Ok(PreparedStep {
            lease_oid,
            workspace_path: Some(path),
            repo_context,
        })
    }

    async fn merge(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
        message: &str,
    ) -> Result<MergeOutcome, PipelineStepError> {
        self.git
            .merge_source(&self.step_dir(run, step), run, message)
            .await
    }

    async fn abort_merge(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<(), PipelineStepError> {
        self.git.abort_merge(&self.step_dir(run, step)).await
    }

    async fn publish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PublishOutcome, PipelineStepError> {
        let directory = self.step_dir(run, step);
        let outcome = self.git.push_head(&directory, step).await?;
        if outcome == PublishOutcome::Pushed {
            let head = self
                .git
                .git_ok(
                    &directory,
                    &["rev-parse", "HEAD"],
                    false,
                    "Reading the pushed commit",
                )
                .await?;
            let repository = self.repository(run)?;
            // The push itself succeeded; failing to move the local branch must not undo it.
            let _ = self
                .fast_forward_local_branch(&repository, &step.target_branch, &head)
                .await;
        }
        Ok(outcome)
    }

    async fn inspect(&self, run: &PipelineRun, step: &PipelineStep) -> RecoveryFinding {
        let directory = self.step_dir(run, step);
        if !directory.exists() {
            return RecoveryFinding::WorkspaceLost;
        }
        self.contexts
            .register(&context_id(&run.run_id, step.position), &directory);
        if self.git.merge_in_progress(&directory).await {
            return RecoveryFinding::MergeInProgress;
        }
        let Some(lease) = step.lease_oid.as_deref() else {
            return RecoveryFinding::NotMerged;
        };
        let head = self
            .git
            .git(&directory, &["rev-parse", "HEAD"], false)
            .await
            .ok()
            .filter(|output| output.success)
            .map(|output| output.stdout);
        let Some(head) = head else {
            return RecoveryFinding::WorkspaceLost;
        };
        if head != lease && self.git.contains_source(&directory, run).await {
            RecoveryFinding::MergedNotPushed
        } else {
            RecoveryFinding::NotMerged
        }
    }

    async fn finish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
        _outcome: StepOutcome,
    ) -> Result<(), PipelineStepError> {
        let directory = self.step_dir(run, step);
        self.contexts
            .unregister(&context_id(&run.run_id, step.position));
        let repository = self.repository(run)?;
        if directory.exists() {
            let path = directory.to_string_lossy().into_owned();
            let _ = self
                .git
                .git(
                    &repository,
                    &["worktree", "remove", "--force", "--", &path],
                    false,
                )
                .await;
            if directory.exists() {
                let _ = tokio::fs::remove_dir_all(&directory).await;
            }
        }
        let _ = self
            .git
            .git(&repository, &["worktree", "prune"], false)
            .await;
        // Drop the run folder once its last step is gone.
        let _ = tokio::fs::remove_dir(self.run_dir(&run.run_id)).await;
        Ok(())
    }
}
