use std::{path::Path, process::Stdio, time::Duration};

use tokio::{io::AsyncWriteExt, process::Command};

use super::{dto::StashEntry, service::StashError};

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
pub(super) const MAX_LISTED_PATHS: usize = 200;

async fn git_output(
    repository_path: &Path,
    arguments: &[&str],
    input: Option<&[u8]>,
) -> Result<(bool, Vec<u8>), StashError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args(arguments)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true);
    let run = async {
        let mut child = command.spawn().map_err(|_| StashError::GitUnavailable)?;
        if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
            stdin
                .write_all(input)
                .await
                .map_err(|_| StashError::Failed)?;
        }
        child
            .wait_with_output()
            .await
            .map_err(|_| StashError::Failed)
    };
    let output = tokio::time::timeout(GIT_TIMEOUT, run)
        .await
        .map_err(|_| StashError::TimedOut)??;
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return Err(StashError::TooLarge);
    }
    Ok((output.status.success(), output.stdout))
}

/// The position of the entry whose commit is `oid`, so a stale request never touches another entry.
pub(super) async fn index_of(repository_path: &Path, oid: &str) -> Result<usize, StashError> {
    Ok(entry_for(repository_path, oid).await?.index)
}

pub(super) async fn entry_for(repository_path: &Path, oid: &str) -> Result<StashEntry, StashError> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StashError::Invalid);
    }
    super::service::list(repository_path)
        .await?
        .into_iter()
        .find(|entry| entry.oid.eq_ignore_ascii_case(oid))
        .ok_or(StashError::NotFound)
}

/// Read the saved object even if its reflog entry moved while resolving conflicts.
pub(crate) async fn recovery_paths(
    repository_path: &Path,
    oid: &str,
) -> Result<Vec<String>, StashError> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StashError::Invalid);
    }
    let (success, output) = git_output(
        repository_path,
        &["show", "--no-patch", "--format=%H%x09%P%x09%ct", oid, "--"],
        None,
    )
    .await?;
    let entry = success
        .then(|| String::from_utf8_lossy(&output))
        .and_then(|text| super::service::parse_line(0, text.trim_end()))
        .ok_or(StashError::NotFound)?;
    restore_paths(repository_path, &entry).await
}

fn split_nul(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect()
}

/// Every path the entry changes, including the untracked files of a `-u` stash.
pub(super) async fn changed_paths(
    repository_path: &Path,
    entry: &StashEntry,
) -> Result<Vec<String>, StashError> {
    read_changed_paths(repository_path, entry, false).await
}

pub(super) async fn restore_paths(
    repository_path: &Path,
    entry: &StashEntry,
) -> Result<Vec<String>, StashError> {
    read_changed_paths(repository_path, entry, true).await
}

async fn read_changed_paths(
    repository_path: &Path,
    entry: &StashEntry,
    include_rename_sources: bool,
) -> Result<Vec<String>, StashError> {
    let mut paths = Vec::new();
    if let Some(base) = &entry.base_oid {
        let mut arguments = vec!["diff", "--name-only", "-z"];
        if include_rename_sources {
            arguments.push("--no-renames");
        }
        arguments.extend([base.as_str(), &entry.oid]);
        let (success, output) = git_output(repository_path, &arguments, None).await?;
        if !success {
            return Err(StashError::Failed);
        }
        paths.extend(split_nul(&output));
    }
    if let Some(untracked) = &entry.untracked_oid {
        paths.extend(tree_paths(repository_path, untracked).await?);
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

async fn tree_paths(repository_path: &Path, tree: &str) -> Result<Vec<String>, StashError> {
    let (success, output) = git_output(
        repository_path,
        &["ls-tree", "-r", "--name-only", "-z", tree],
        None,
    )
    .await?;
    if !success {
        return Err(StashError::Failed);
    }
    Ok(split_nul(&output))
}

pub(super) async fn untracked_overlaps_index(
    repository_path: &Path,
    saved_untracked: &str,
    index_tree: &str,
) -> Result<bool, StashError> {
    let (saved, indexed) = tokio::try_join!(
        tree_paths(repository_path, saved_untracked),
        tree_paths(repository_path, index_tree)
    )?;
    let indexed: std::collections::HashSet<_> = indexed.into_iter().collect();
    Ok(saved.iter().any(|path| indexed.contains(path)))
}

/// One patch with the tracked changes and, for a `-u` stash, the untracked files as additions.
pub(super) async fn import_patch(
    repository_path: &Path,
    entry: &StashEntry,
) -> Result<Vec<u8>, StashError> {
    let mut patch = Vec::new();
    if let Some(base) = &entry.base_oid {
        let (success, output) = git_output(
            repository_path,
            &[
                "diff",
                "--binary",
                "--full-index",
                "--no-color",
                "--no-ext-diff",
                base,
                &entry.oid,
            ],
            None,
        )
        .await?;
        if !success {
            return Err(StashError::Failed);
        }
        patch.extend(output);
    }
    if let Some(untracked) = &entry.untracked_oid {
        let (success, output) = git_output(
            repository_path,
            &[
                "diff-tree",
                "-r",
                "-p",
                "--binary",
                "--full-index",
                "--no-color",
                "--root",
                "--no-commit-id",
                untracked,
            ],
            None,
        )
        .await?;
        if !success {
            return Err(StashError::Failed);
        }
        patch.extend(output);
    }
    Ok(patch)
}

/// Looks up the current stash index for the reviewed commit immediately before dropping it.
pub(super) async fn drop_entry(repository_path: &Path, oid: &str) -> Result<(), StashError> {
    let index = index_of(repository_path, oid).await?;
    let reference = format!("stash@{{{index}}}");
    let (success, _) = git_output(
        repository_path,
        &["stash", "drop", "--quiet", &reference],
        None,
    )
    .await?;
    if success {
        Ok(())
    } else {
        Err(StashError::Failed)
    }
}
