use std::{process::Stdio, time::Duration};

use tokio::process::Command;

use super::workspace::PipelineStepError;
use crate::domain::pipeline::{HookCommand, PipelineRun};

pub(super) async fn execute(
    repository: &str,
    run: &PipelineRun,
    action: &HookCommand,
) -> Result<String, PipelineStepError> {
    let mut command = Command::new(&action.program);
    command
        .args(&action.args)
        .current_dir(repository)
        .env("GITCREST_EVENT", run.rule.trigger.event_name())
        .env("GITCREST_BRANCH", &run.source_branch)
        .env("GITCREST_COMMIT", &run.source_oid)
        .env("GITCREST_REPO_ID", &run.repo_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|error| {
        PipelineStepError::new(format!("Could not start hook program: {error}"))
    })?;
    let status =
        match tokio::time::timeout(Duration::from_secs(action.timeout_seconds), child.wait()).await
        {
            Ok(Ok(status)) => status,
            result => {
                crate::git::command::terminate_process_tree(&mut child).await;
                return Err(PipelineStepError::new(if result.is_err() {
                    format!(
                        "Hook command timed out after {} seconds",
                        action.timeout_seconds
                    )
                } else {
                    "Could not wait for hook command".into()
                }));
            }
        };
    if status.success() {
        Ok("Command completed (exit code 0)".into())
    } else {
        Err(PipelineStepError::new(format!(
            "Hook command failed: {status}"
        )))
    }
}
