use std::{ffi::OsString, path::PathBuf, sync::Arc};

use crate::domain::pipeline::{InPlaceDirtyPolicy, PipelineRun, PipelineStep};

use super::{
    gitops::GitRunner,
    workspace::{
        MergeOutcome, PipelineStepError, PipelineWorkspace, PreparedStep, PublishOutcome,
        RecoveryFinding, StepOutcome,
    },
    worktree::RepositoryPaths,
};

type DirtyPolicy = dyn Fn(&str) -> InPlaceDirtyPolicy + Send + Sync;

const OPERATION_MARKERS: [&str; 7] = [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "BISECT_LOG",
];

/// Switches the user's own working tree to each target in turn and always
/// returns to the source branch. Uncommitted work is set aside in a stash for
/// the whole run (or the run is refused), per the repository's dirty policy.
pub(crate) struct InPlaceWorkspace {
    git: GitRunner,
    repository_paths: Arc<RepositoryPaths>,
    dirty_policy: Arc<DirtyPolicy>,
}

fn stash_message(run: &PipelineRun) -> String {
    format!("gitcrest-pipeline-{}", run.run_id)
}

impl InPlaceWorkspace {
    pub(crate) fn new(
        repository_paths: Arc<RepositoryPaths>,
        dirty_policy: Arc<DirtyPolicy>,
    ) -> Self {
        Self {
            git: GitRunner::new(),
            repository_paths,
            dirty_policy,
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

    fn repository(&self, run: &PipelineRun) -> Result<PathBuf, PipelineStepError> {
        (self.repository_paths)(&run.repo_id)
            .ok_or_else(|| PipelineStepError::new("The repository is no longer available"))
    }

    /// True while the user's tree still has a merge waiting to be concluded.
    pub(crate) async fn merge_in_progress(&self, run: &PipelineRun) -> bool {
        match self.repository(run) {
            Ok(repository) => self.git.merge_in_progress(&repository).await,
            Err(_) => false,
        }
    }

    async fn operation_in_progress(&self, repository: &std::path::Path) -> bool {
        for marker in OPERATION_MARKERS {
            let located = self
                .git
                .git(repository, &["rev-parse", "--git-path", marker], false)
                .await;
            if let Ok(output) = located {
                let path = std::path::Path::new(&output.stdout);
                let path = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    repository.join(path)
                };
                if output.success && path.exists() {
                    return true;
                }
            }
        }
        false
    }

    async fn stash_ref_for(
        &self,
        repository: &std::path::Path,
        oid: &str,
    ) -> Result<Option<String>, PipelineStepError> {
        let list = self
            .git
            .git_ok(
                repository,
                &["stash", "list", "--format=%H"],
                false,
                "Listing the stash",
            )
            .await?;
        Ok(list
            .lines()
            .position(|line| line.trim() == oid)
            .map(|index| format!("stash@{{{index}}}")))
    }
}

impl PipelineWorkspace for InPlaceWorkspace {
    async fn begin_run(&self, run: &PipelineRun) -> Result<Option<String>, PipelineStepError> {
        let repository = self.repository(run)?;
        if self.operation_in_progress(&repository).await {
            return Err(PipelineStepError::new(
                "A Git operation is in progress in this repository; finish or abort it first",
            ));
        }
        let source = format!("refs/heads/{}", run.source_branch);
        let source_exists = self
            .git
            .git(
                &repository,
                &["rev-parse", "--verify", "-q", &source],
                false,
            )
            .await?;
        if !source_exists.success {
            return Err(PipelineStepError::new(format!(
                "The source branch {} does not exist locally",
                run.source_branch
            )));
        }
        let status = self
            .git
            .git_ok(
                &repository,
                &["status", "--porcelain", "--untracked-files=normal"],
                false,
                "Reading the working tree",
            )
            .await?;
        if status.is_empty() {
            return Ok(None);
        }
        if (self.dirty_policy)(&run.repo_id) == InPlaceDirtyPolicy::Refuse {
            return Err(PipelineStepError::new(
                "The working tree has uncommitted changes; commit or shelve them first",
            ));
        }
        let message = stash_message(run);
        self.git
            .git_ok(
                &repository,
                &["stash", "push", "--include-untracked", "-m", &message],
                false,
                "Setting your changes aside",
            )
            .await?;
        let oid = self
            .git
            .git_ok(
                &repository,
                &["rev-parse", "--verify", "refs/stash"],
                false,
                "Reading the stash",
            )
            .await?;
        Ok(Some(oid))
    }

    async fn end_run(&self, run: &PipelineRun) -> Result<(), PipelineStepError> {
        let Some(oid) = run.shelf_id.as_deref() else {
            return Ok(());
        };
        let repository = self.repository(run)?;
        let Some(stash) = self.stash_ref_for(&repository, oid).await? else {
            return Err(PipelineStepError::new(
                "Your set-aside changes were not found in the stash list",
            ));
        };
        let restored = self
            .git
            .git(&repository, &["stash", "pop", "--index", &stash], false)
            .await?;
        if restored.success {
            return Ok(());
        }
        // `--index` can fail where a plain pop works; retry once before giving up.
        let retry = self
            .git
            .git(&repository, &["stash", "pop", &stash], false)
            .await?;
        if retry.success {
            return Ok(());
        }
        Err(PipelineStepError::new(format!(
            "Restoring your changes failed; they are kept as {stash} in the stash list"
        )))
    }

    async fn prepare(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PreparedStep, PipelineStepError> {
        let repository = self.repository(run)?;
        let lease_oid = self.git.fetch_lease(&repository, step).await?;
        let target = &step.target_branch;
        let reference = format!("refs/heads/{target}");
        let local = self
            .git
            .git(
                &repository,
                &["rev-parse", "--verify", "-q", &reference],
                false,
            )
            .await?;
        if local.success {
            self.git
                .git_ok(
                    &repository,
                    &["checkout", "--quiet", target],
                    false,
                    &format!("Switching to {target}"),
                )
                .await?;
            if local.stdout != lease_oid {
                let behind = self
                    .git
                    .git(
                        &repository,
                        &["merge-base", "--is-ancestor", &local.stdout, &lease_oid],
                        false,
                    )
                    .await?;
                if behind.success {
                    self.git
                        .git_ok(
                            &repository,
                            &["merge", "--ff-only", "--quiet", &lease_oid],
                            false,
                            &format!("Updating {target}"),
                        )
                        .await?;
                } else {
                    let ahead = self
                        .git
                        .git(
                            &repository,
                            &["merge-base", "--is-ancestor", &lease_oid, &local.stdout],
                            false,
                        )
                        .await?;
                    return Err(PipelineStepError::new(if ahead.success {
                        format!("Local {target} has unpushed commits")
                    } else {
                        format!("Local {target} has diverged from {}/{target}", step.remote)
                    }));
                }
            }
        } else {
            let tracking = format!("refs/remotes/{}/{target}", step.remote);
            self.git
                .git_ok(
                    &repository,
                    &["checkout", "--quiet", "-b", target, "--track", &tracking],
                    false,
                    &format!("Creating {target}"),
                )
                .await?;
        }
        Ok(PreparedStep {
            lease_oid,
            workspace_path: Some(repository.to_string_lossy().into_owned()),
            repo_context: run.repo_id.clone(),
        })
    }

    async fn merge(
        &self,
        run: &PipelineRun,
        _step: &PipelineStep,
        message: &str,
    ) -> Result<MergeOutcome, PipelineStepError> {
        let repository = self.repository(run)?;
        self.git.merge_source(&repository, run, message).await
    }

    async fn abort_merge(
        &self,
        run: &PipelineRun,
        _step: &PipelineStep,
    ) -> Result<(), PipelineStepError> {
        let repository = self.repository(run)?;
        self.git.abort_merge(&repository).await
    }

    async fn publish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PublishOutcome, PipelineStepError> {
        let repository = self.repository(run)?;
        self.git.push_head(&repository, step).await
    }

    async fn inspect(&self, run: &PipelineRun, step: &PipelineStep) -> RecoveryFinding {
        let Ok(repository) = self.repository(run) else {
            return RecoveryFinding::WorkspaceLost;
        };
        if self.git.merge_in_progress(&repository).await {
            return RecoveryFinding::MergeInProgress;
        }
        let current = self
            .git
            .git(
                &repository,
                &["symbolic-ref", "-q", "--short", "HEAD"],
                false,
            )
            .await
            .ok()
            .filter(|output| output.success)
            .map(|output| output.stdout);
        if current.as_deref() != Some(step.target_branch.as_str()) {
            return RecoveryFinding::NotMerged;
        }
        let head = self
            .git
            .git(&repository, &["rev-parse", "HEAD"], false)
            .await
            .ok()
            .map(|output| output.stdout);
        let merged = step.lease_oid.is_some()
            && head != step.lease_oid
            && self.git.contains_source(&repository, run).await;
        if merged {
            RecoveryFinding::MergedNotPushed
        } else {
            RecoveryFinding::LeftOnTarget
        }
    }

    async fn finish(
        &self,
        run: &PipelineRun,
        _step: &PipelineStep,
        outcome: StepOutcome,
    ) -> Result<(), PipelineStepError> {
        if matches!(outcome, StepOutcome::Retry | StepOutcome::Stay) {
            return Ok(());
        }
        let repository = self.repository(run)?;
        self.git
            .git_ok(
                &repository,
                &["checkout", "--quiet", &run.source_branch],
                false,
                &format!("Returning to {}", run.source_branch),
            )
            .await
            .map(|_| ())
    }
}
