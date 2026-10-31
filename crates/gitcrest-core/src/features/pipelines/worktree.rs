use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use tokio::process::Command;

use crate::domain::pipeline::{MergeMode, PipelineRun, PipelineStep};

use super::{
    ephemeral::EphemeralContexts,
    workspace::{
        MergeOutcome, PipelineStepError, PipelineWorkspace, PreparedStep, PublishOutcome,
        StepOutcome,
    },
};

type RepositoryPaths = dyn Fn(&str) -> Option<PathBuf> + Send + Sync;

struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Runs every step in a temporary detached linked worktree under the app data
/// directory, so the user's working tree and current branch are never touched.
pub(crate) struct WorktreeWorkspace {
    git_program: String,
    data_dir: PathBuf,
    repository_paths: Arc<RepositoryPaths>,
    contexts: Arc<EphemeralContexts>,
    network_environment: Vec<(OsString, OsString)>,
}

impl WorktreeWorkspace {
    pub(crate) fn new(
        data_dir: PathBuf,
        repository_paths: Arc<RepositoryPaths>,
        contexts: Arc<EphemeralContexts>,
    ) -> Self {
        Self {
            git_program: "git".into(),
            data_dir,
            repository_paths,
            contexts,
            network_environment: Vec::new(),
        }
    }

    /// Environment for commands that talk to a remote (credential helpers).
    pub(crate) fn with_network_environment(
        mut self,
        environment: Vec<(OsString, OsString)>,
    ) -> Self {
        self.network_environment = environment;
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

    async fn git(
        &self,
        directory: &Path,
        args: &[&str],
        network: bool,
    ) -> Result<GitOutput, PipelineStepError> {
        let mut command = Command::new(&self.git_program);
        command
            .args(args)
            .current_dir(directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .kill_on_drop(true);
        if network {
            command.envs(self.network_environment.iter().cloned());
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let output = command
            .output()
            .await
            .map_err(|_| PipelineStepError::new("Git could not be started"))?;
        Ok(GitOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }

    async fn git_ok(
        &self,
        directory: &Path,
        args: &[&str],
        network: bool,
        what: &str,
    ) -> Result<String, PipelineStepError> {
        let output = self.git(directory, args, network).await?;
        if output.success {
            Ok(output.stdout)
        } else {
            Err(PipelineStepError::new(format!(
                "{what} failed: {}",
                first_line(&output.stderr)
            )))
        }
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
            .git(repository, &["worktree", "list", "--porcelain"], false)
            .await?;
        let checked_out = worktrees
            .stdout
            .lines()
            .any(|line| line.strip_prefix("branch ") == Some(reference.as_str()));
        if checked_out {
            return Ok(());
        }
        self.git_ok(
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
        let directory = self.step_dir(run, step);
        self.git(
            &directory,
            &["rev-parse", "-q", "--verify", "MERGE_HEAD"],
            false,
        )
        .await
        .map(|output| output.success)
        .unwrap_or(false)
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
            let _ = self.git(repository, &["worktree", "prune"], false).await;
        }
    }
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("no details")
}

impl PipelineWorkspace for WorktreeWorkspace {
    async fn prepare(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PreparedStep, PipelineStepError> {
        let repository = self.repository(run)?;
        let target = &step.target_branch;
        let remote = &step.remote;
        let refspec = format!("+refs/heads/{target}:refs/remotes/{remote}/{target}");
        self.git_ok(
            &repository,
            &["fetch", "--quiet", "--", remote, &refspec],
            true,
            &format!("Fetching {remote}/{target}"),
        )
        .await?;
        let tracking = format!("refs/remotes/{remote}/{target}^{{commit}}");
        let lease_oid = self
            .git_ok(
                &repository,
                &["rev-parse", "--verify", &tracking],
                false,
                &format!("Reading {remote}/{target}"),
            )
            .await?;

        let directory = self.step_dir(run, step);
        if directory.exists() {
            let _ = tokio::fs::remove_dir_all(&directory).await;
            let _ = self.git(&repository, &["worktree", "prune"], false).await;
        }
        if let Some(parent) = directory.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|_| {
                PipelineStepError::new("The pipeline worktree folder could not be created")
            })?;
        }
        let path = directory.to_string_lossy().into_owned();
        self.git_ok(
            &repository,
            &["worktree", "add", "--detach", "--", &path, &lease_oid],
            false,
            "Creating the pipeline worktree",
        )
        .await?;

        let repo_context = format!("pipeline-{}-{}", run.run_id, step.position);
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
        let directory = self.step_dir(run, step);
        let contained = self
            .git(
                &directory,
                &["merge-base", "--is-ancestor", &run.source_oid, "HEAD"],
                false,
            )
            .await?;
        if contained.success {
            return Ok(MergeOutcome::UpToDate);
        }
        let mut args = vec!["merge", "-m", message];
        match run.rule.merge_mode {
            MergeMode::NoFastForward => args.push("--no-ff"),
            MergeMode::FastForwardIfPossible => {}
        }
        args.extend(["--", &run.source_oid]);
        let output = self.git(&directory, &args, false).await?;
        if output.success {
            let oid = self
                .git_ok(
                    &directory,
                    &["rev-parse", "HEAD"],
                    false,
                    "Reading the merge",
                )
                .await?;
            return Ok(MergeOutcome::Merged { oid });
        }
        let merging = self
            .git(
                &directory,
                &["rev-parse", "-q", "--verify", "MERGE_HEAD"],
                false,
            )
            .await?;
        if merging.success {
            Ok(MergeOutcome::Conflicts)
        } else {
            Err(PipelineStepError::new(format!(
                "Merge failed: {}",
                first_line(if output.stderr.is_empty() {
                    &output.stdout
                } else {
                    &output.stderr
                })
            )))
        }
    }

    async fn abort_merge(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<(), PipelineStepError> {
        let directory = self.step_dir(run, step);
        self.git_ok(
            &directory,
            &["merge", "--abort"],
            false,
            "Aborting the merge",
        )
        .await
        .map(|_| ())
    }

    async fn publish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
    ) -> Result<PublishOutcome, PipelineStepError> {
        let directory = self.step_dir(run, step);
        let lease = step
            .lease_oid
            .as_deref()
            .ok_or_else(|| PipelineStepError::new("The step has no remote lease"))?;
        let target = &step.target_branch;
        let lease_argument = format!("--force-with-lease=refs/heads/{target}:{lease}");
        let destination = format!("HEAD:refs/heads/{target}");
        let output = self
            .git(
                &directory,
                &[
                    "push",
                    "--porcelain",
                    &lease_argument,
                    "--",
                    &step.remote,
                    &destination,
                ],
                true,
            )
            .await?;
        if !output.success {
            let combined = format!("{}\n{}", output.stdout, output.stderr);
            if combined.contains("stale info") || combined.contains("[rejected]") {
                return Ok(PublishOutcome::LeaseRejected);
            }
            return Err(PipelineStepError::new(format!(
                "Push failed: {}",
                first_line(&output.stderr)
            )));
        }
        let head = self
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
            .fast_forward_local_branch(&repository, target, &head)
            .await;
        Ok(PublishOutcome::Pushed)
    }

    async fn finish(
        &self,
        run: &PipelineRun,
        step: &PipelineStep,
        _outcome: StepOutcome,
    ) -> Result<(), PipelineStepError> {
        let directory = self.step_dir(run, step);
        self.contexts
            .unregister(&format!("pipeline-{}-{}", run.run_id, step.position));
        let repository = self.repository(run)?;
        if directory.exists() {
            let path = directory.to_string_lossy().into_owned();
            let _ = self
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
        let _ = self.git(&repository, &["worktree", "prune"], false).await;
        // Drop the run folder once its last step is gone.
        let _ = tokio::fs::remove_dir(self.run_dir(&run.run_id)).await;
        Ok(())
    }
}
