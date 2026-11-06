use std::{path::Path, process::Stdio};

use tokio::process::Command;

use crate::domain::pipeline::{MergeMode, PipelineRun, PipelineStep};

use crate::git::command::GitCommandService;

use super::workspace::{MergeOutcome, PipelineStepError, PublishOutcome};

pub(super) struct GitOutput {
    pub(super) success: bool,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

/// Plain Git processes shared by the workspaces.
pub(super) struct GitRunner {
    shutdown: Option<tokio::sync::watch::Receiver<bool>>,
    program: String,
    /// Supplies the askpass environment (selected account, renewed tokens) for remote commands.
    credentials: Option<GitCommandService>,
}

impl GitRunner {
    pub(super) fn new() -> Self {
        Self {
            shutdown: None,
            program: "git".into(),
            credentials: None,
        }
    }

    pub(super) fn with_shutdown(mut self, signal: tokio::sync::watch::Receiver<bool>) -> Self {
        self.shutdown = Some(signal);
        self
    }

    pub(super) fn is_closing(&self) -> bool {
        super::shutdown::requested(&self.shutdown)
    }

    #[cfg(test)]
    pub(super) fn with_program(mut self, program: String) -> Self {
        self.program = program;
        self
    }

    pub(super) fn with_credentials(mut self, service: GitCommandService) -> Self {
        self.credentials = Some(service);
        self
    }

    pub(super) async fn git(
        &self,
        directory: &Path,
        args: &[&str],
        network: bool,
    ) -> Result<GitOutput, PipelineStepError> {
        if super::shutdown::requested(&self.shutdown) {
            return Err(PipelineStepError::new(
                "GitCrest is closing; the Git result must be reviewed before continuing",
            ));
        }
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
            if let Some(service) = &self.credentials {
                let environment = service
                    .network_environment()
                    .await
                    .map_err(|_| PipelineStepError::new("Credentials are unavailable"))?;
                command.envs(environment);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        #[cfg(unix)]
        command.process_group(0);
        // Credentials may have needed a network round trip. Recheck shutdown
        // immediately before starting a process with filesystem side effects.
        if super::shutdown::requested(&self.shutdown) {
            return Err(PipelineStepError::new(
                "GitCrest is closing; Git was not started",
            ));
        }
        let mut child = command
            .spawn()
            .map_err(|_| PipelineStepError::new("Git could not be started"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| PipelineStepError::new("Git output is unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| PipelineStepError::new("Git diagnostics are unavailable"))?;
        let mut stdout = tokio::spawn(read_output(stdout));
        let mut stderr = tokio::spawn(read_output(stderr));
        let status = tokio::select! {
            biased;
            _ = super::shutdown::wait(self.shutdown.clone()) => {
                crate::git::command::terminate_process_tree(&mut child).await;
                let _ = child.wait().await;
                // Readers drain concurrently so a full pipe cannot keep the
                // process from exiting while the write permit is still held.
                stdout.abort();
                stderr.abort();
                return Err(PipelineStepError::new("Git was interrupted while GitCrest closed; its result requires review"));
            }
            status = child.wait() => match status {
                Ok(status) => status,
                Err(_) => {
                    crate::git::command::terminate_process_tree(&mut child).await;
                    let _ = child.wait().await;
                    stdout.abort(); stderr.abort();
                    return Err(PipelineStepError::new("Git could not be waited for; its result requires review"));
                }
            },
        };
        let output = tokio::select! {
            biased;
            _ = super::shutdown::wait(self.shutdown.clone()) => {
                stdout.abort(); stderr.abort();
                return Err(PipelineStepError::new("Git output was interrupted while closing; its result requires review"));
            }
            output = async {
                let stdout = (&mut stdout).await.map_err(|_| PipelineStepError::new("Git output could not be read"))?
                    .map_err(|_| PipelineStepError::new("Git output could not be read"))?;
                let stderr = (&mut stderr).await.map_err(|_| PipelineStepError::new("Git diagnostics could not be read"))?
                    .map_err(|_| PipelineStepError::new("Git diagnostics could not be read"))?;
                Ok::<_, PipelineStepError>((stdout, stderr))
            } => output,
        };
        let (stdout, stderr) = match output {
            Ok(output) => output,
            Err(error) => {
                stdout.abort();
                stderr.abort();
                return Err(error);
            }
        };
        if stdout.len() > 2 * 1024 * 1024 || stderr.len() > 2 * 1024 * 1024 {
            return Err(PipelineStepError::new(
                "Git output exceeded the capture limit; its result requires review",
            ));
        }
        Ok(GitOutput {
            success: status.success(),
            stdout: String::from_utf8_lossy(&stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
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

    /// Whether the run's source commit is part of what `directory` has checked out.
    pub(super) async fn contains_source(&self, directory: &Path, run: &PipelineRun) -> bool {
        self.git(
            directory,
            &["merge-base", "--is-ancestor", &run.source_oid, "HEAD"],
            false,
        )
        .await
        .map(|output| output.success)
        .unwrap_or(false)
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
        if !self.merge_in_progress(directory).await {
            return Ok(());
        }
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

async fn read_output(mut reader: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut result = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            return Ok(result);
        }
        let remaining = (2 * 1024 * 1024 + 1_usize).saturating_sub(result.len());
        result.extend_from_slice(&buffer[..count.min(remaining)]);
    }
}

pub(super) fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("no details")
}

#[cfg(test)]
mod output_tests {
    #[tokio::test]
    async fn capture_retains_a_bounded_prefix_but_drains_the_writer_to_completion() {
        use tokio::io::AsyncWriteExt;
        let (reader, mut writer) = tokio::io::duplex(4096);
        let write = tokio::spawn(async move {
            writer
                .write_all(&vec![b'x'; 3 * 1024 * 1024])
                .await
                .unwrap();
        });
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            super::read_output(reader),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(output.len(), 2 * 1024 * 1024 + 1);
        write.await.unwrap();
    }
}
