use std::{ffi::OsString, path::Path, process::Stdio};

use tokio::process::Command;

use crate::domain::pipeline::{MergeMode, PipelineRun, PipelineStep};

use super::workspace::{MergeOutcome, PipelineStepError, PublishOutcome};

pub(super) struct GitOutput {
    pub(super) success: bool,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

/// Plain Git processes shared by the workspaces.
pub(super) struct GitRunner {
    program: String,
    network_environment: Vec<(OsString, OsString)>,
}

impl GitRunner {
    pub(super) fn new() -> Self {
        Self {
            program: "git".into(),
            network_environment: Vec::new(),
        }
    }

    pub(super) fn with_network_environment(
        mut self,
        environment: Vec<(OsString, OsString)>,
    ) -> Self {
        self.network_environment = environment;
        self
    }

    pub(super) async fn git(
        &self,
        directory: &Path,
        args: &[&str],
        network: bool,
    ) -> Result<GitOutput, PipelineStepError> {
        let mut command = Command::new(&self.program);
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

    pub(super) async fn git_ok(
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

    /// Fetches the target and returns the remote oid the later push is leased against.
    pub(super) async fn fetch_lease(
        &self,
        repository: &Path,
        step: &PipelineStep,
    ) -> Result<String, PipelineStepError> {
        let target = &step.target_branch;
        let remote = &step.remote;
        let refspec = format!("+refs/heads/{target}:refs/remotes/{remote}/{target}");
        self.git_ok(
            repository,
            &["fetch", "--quiet", "--", remote, &refspec],
            true,
            &format!("Fetching {remote}/{target}"),
        )
        .await?;
        let tracking = format!("refs/remotes/{remote}/{target}^{{commit}}");
        self.git_ok(
            repository,
            &["rev-parse", "--verify", &tracking],
            false,
            &format!("Reading {remote}/{target}"),
        )
        .await
    }

    /// Merges the run's source commit into whatever `directory` has checked out.
    pub(super) async fn merge_source(
        &self,
        directory: &Path,
        run: &PipelineRun,
        message: &str,
    ) -> Result<MergeOutcome, PipelineStepError> {
        let contained = self
            .git(
                directory,
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
        let output = self.git(directory, &args, false).await?;
        if output.success {
            let oid = self
                .git_ok(
                    directory,
                    &["rev-parse", "HEAD"],
                    false,
                    "Reading the merge",
                )
                .await?;
            return Ok(MergeOutcome::Merged { oid });
        }
        if self.merge_in_progress(directory).await {
            Ok(MergeOutcome::Conflicts)
        } else {
            let details = if output.stderr.is_empty() {
                &output.stdout
            } else {
                &output.stderr
            };
            Err(PipelineStepError::new(format!(
                "Merge failed: {}",
                first_line(details)
            )))
        }
    }

    pub(super) async fn merge_in_progress(&self, directory: &Path) -> bool {
        self.git(
            directory,
            &["rev-parse", "-q", "--verify", "MERGE_HEAD"],
            false,
        )
        .await
        .map(|output| output.success)
        .unwrap_or(false)
    }

    pub(super) async fn abort_merge(&self, directory: &Path) -> Result<(), PipelineStepError> {
        self.git_ok(
            directory,
            &["merge", "--abort"],
            false,
            "Aborting the merge",
        )
        .await
        .map(|_| ())
    }

    /// Pushes `HEAD` to the step's target with the lease taken in `fetch_lease`.
    pub(super) async fn push_head(
        &self,
        directory: &Path,
        step: &PipelineStep,
    ) -> Result<PublishOutcome, PipelineStepError> {
        let lease = step
            .lease_oid
            .as_deref()
            .ok_or_else(|| PipelineStepError::new("The step has no remote lease"))?;
        let target = &step.target_branch;
        let lease_argument = format!("--force-with-lease=refs/heads/{target}:{lease}");
        let destination = format!("HEAD:refs/heads/{target}");
        let output = self
            .git(
                directory,
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
        if output.success {
            return Ok(PublishOutcome::Pushed);
        }
        let combined = format!("{}\n{}", output.stdout, output.stderr);
        if combined.contains("stale info") || combined.contains("[rejected]") {
            return Ok(PublishOutcome::LeaseRejected);
        }
        Err(PipelineStepError::new(format!(
            "Push failed: {}",
            first_line(&output.stderr)
        )))
    }
}

pub(super) fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("no details")
}
