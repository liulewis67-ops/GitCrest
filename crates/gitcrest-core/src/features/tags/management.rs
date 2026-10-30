use std::{path::Path, process::Stdio, time::Duration};

use tokio::process::Command;

use super::service::TagError;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

/// A tag or remote name Git would accept, and that cannot be read as an option.
pub(super) fn validate_tag_name(name: &str) -> Result<(), TagError> {
    if name.is_empty()
        || name.len() > 255
        || name.starts_with('-')
        || name
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || name.contains(['~', '^', ':', '?', '*', '[', '\\'])
        || name.contains("..")
    {
        return Err(TagError::Invalid);
    }
    Ok(())
}

pub(super) fn validate_remote_name(name: &str) -> Result<(), TagError> {
    if name.is_empty()
        || name.len() > 255
        || name.starts_with('-')
        || name
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(TagError::Invalid);
    }
    Ok(())
}

pub(super) fn validate_oid(oid: &str) -> Result<(), TagError> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(TagError::Invalid)
    }
}

async fn run_git(repository_path: &Path, arguments: &[&str]) -> Result<(bool, String), TagError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository_path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(COMMAND_TIMEOUT, output).await {
        Ok(Ok(output)) => Ok((
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        )),
        Ok(Err(_)) => Err(TagError::GitUnavailable),
        Err(_) => Err(TagError::TimedOut),
    }
}

/// The object a local tag points at (the tag object itself for an annotated tag).
pub(super) async fn local_tag_object(
    repository_path: &Path,
    name: &str,
) -> Result<Option<String>, TagError> {
    let reference = format!("refs/tags/{name}");
    let (success, output) = run_git(
        repository_path,
        &["rev-parse", "--verify", "--quiet", &reference],
    )
    .await?;
    Ok((success && !output.is_empty()).then_some(output))
}

/// The commit a local tag resolves to.
pub(super) async fn local_tag_commit(
    repository_path: &Path,
    name: &str,
) -> Result<Option<String>, TagError> {
    let reference = format!("refs/tags/{name}^{{commit}}");
    let (success, output) = run_git(
        repository_path,
        &["rev-parse", "--verify", "--quiet", &reference],
    )
    .await?;
    Ok((success && !output.is_empty()).then_some(output))
}

pub(super) async fn remote_exists(
    repository_path: &Path,
    remote_name: &str,
) -> Result<bool, TagError> {
    let (success, output) = run_git(repository_path, &["remote"]).await?;
    Ok(success && output.lines().any(|line| line == remote_name))
}

/// Deletes a local tag, but only while it still resolves to the reviewed commit.
pub(super) async fn delete_local(
    repository_path: &Path,
    name: &str,
    expected_target_oid: &str,
) -> Result<(), TagError> {
    validate_tag_name(name)?;
    validate_oid(expected_target_oid)?;
    let Some(commit) = local_tag_commit(repository_path, name).await? else {
        return Err(TagError::NotFound);
    };
    if !commit.eq_ignore_ascii_case(expected_target_oid) {
        return Err(TagError::Stale);
    }
    let (success, _) = run_git(repository_path, &["tag", "--delete", "--", name]).await?;
    if success {
        Ok(())
    } else {
        Err(TagError::GitFailed)
    }
}
