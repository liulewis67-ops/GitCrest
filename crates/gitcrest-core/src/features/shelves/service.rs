use std::{
    ffi::OsString,
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt, process::Command};

use crate::features::{diff::DiffScope, staging::StagingCommand};

pub const MAX_PATCH_BYTES: usize = 10 * 1024 * 1024;
const APPLY_CHECK_DEADLINE: Duration = Duration::from_secs(10);
static NEXT_SHELF_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShelfSnapshot {
    pub shelf_id: String,
    pub repo_id: String,
    pub name: String,
    pub description: String,
    pub paths: Vec<String>,
    pub scope: Option<DiffScope>,
    pub head_oid: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShelfRecord {
    pub snapshot: ShelfSnapshot,
    pub patch: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ShelfError {
    InvalidName,
    InvalidDescription,
    EmptySelection,
    PatchTooLarge,
    MixedScopes,
    GitUnavailable,
    GitTimedOut,
}

pub fn new_shelf_id() -> String {
    let timestamp = now_ms();
    format!(
        "shelf-{timestamp}-{}",
        NEXT_SHELF_ID.fetch_add(1, Ordering::Relaxed)
    )
}

pub fn now_ms() -> i64 {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(timestamp).unwrap_or(i64::MAX)
}

pub fn validate_metadata(name: &str, description: &str) -> Result<(), ShelfError> {
    let name = name.trim();
    if name.is_empty() || name.chars().any(char::is_control) || name.chars().count() > 120 {
        return Err(ShelfError::InvalidName);
    }
    if description
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
    {
        return Err(ShelfError::InvalidDescription);
    }
    if description.chars().count() > 500 {
        return Err(ShelfError::InvalidDescription);
    }
    Ok(())
}

pub fn validate_patch(patch: &[u8], paths: &[String]) -> Result<(), ShelfError> {
    if paths.is_empty() || patch.is_empty() {
        return Err(ShelfError::EmptySelection);
    }
    if patch.len() > MAX_PATCH_BYTES {
        return Err(ShelfError::PatchTooLarge);
    }
    Ok(())
}

pub fn apply_command(
    patch: Vec<u8>,
    scope: DiffScope,
    reverse: bool,
    check: bool,
) -> StagingCommand {
    let mut arguments = vec![OsString::from("apply")];
    if check {
        arguments.push("--check".into());
    }
    if reverse {
        arguments.push("--reverse".into());
    }
    if scope == DiffScope::Index {
        arguments.push("--cached".into());
    }
    StagingCommand {
        arguments,
        input: Some(patch),
        label: if check {
            "Check shelve patch"
        } else if reverse {
            "Remove shelved changes"
        } else {
            "Restore shelved changes"
        },
        log_label: "git apply <shelve patch>",
    }
}

pub fn cleanup_commands(patch: Vec<u8>, scope: DiffScope) -> Vec<(DiffScope, StagingCommand)> {
    match scope {
        DiffScope::WorkingTree => vec![(scope, apply_command(patch, scope, true, false))],
        DiffScope::Index => vec![
            (scope, apply_command(patch.clone(), scope, true, false)),
            (
                DiffScope::WorkingTree,
                apply_command(patch, DiffScope::WorkingTree, true, false),
            ),
        ],
        DiffScope::Commit => Vec::new(),
    }
}

pub fn check_commands(patch: Vec<u8>, scope: DiffScope) -> Vec<(DiffScope, StagingCommand)> {
    match scope {
        DiffScope::WorkingTree => vec![(scope, apply_command(patch, scope, true, true))],
        DiffScope::Index => vec![
            (scope, apply_command(patch.clone(), scope, true, true)),
            (
                DiffScope::WorkingTree,
                apply_command(patch, DiffScope::WorkingTree, true, true),
            ),
        ],
        DiffScope::Commit => Vec::new(),
    }
}

pub fn rollback_command(patch: Vec<u8>, scope: DiffScope) -> StagingCommand {
    apply_command(patch, scope, false, false)
}

pub fn restore_command(patch: Vec<u8>, scope: DiffScope) -> StagingCommand {
    let mut arguments = vec![OsString::from("apply")];
    if scope == DiffScope::Index {
        arguments.push("--index".into());
    }
    StagingCommand {
        arguments,
        input: Some(patch),
        label: "Apply saved shelf",
        log_label: "git apply <shelf patch>",
    }
}

pub fn undo_apply_command(patch: Vec<u8>, scope: DiffScope) -> StagingCommand {
    let mut arguments = vec![OsString::from("apply"), OsString::from("--reverse")];
    if scope == DiffScope::Index {
        arguments.push("--index".into());
    }
    StagingCommand {
        arguments,
        input: Some(patch),
        label: "Undo saved shelf apply",
        log_label: "git apply --reverse <shelf patch>",
    }
}

pub fn restore_three_way_command(patch: Vec<u8>) -> StagingCommand {
    StagingCommand {
        arguments: ["apply", "--3way", "--index"]
            .into_iter()
            .map(OsString::from)
            .collect(),
        input: Some(patch),
        label: "Apply shelf with three-way conflict resolution",
        log_label: "git apply --3way --index <shelf patch>",
    }
}

pub fn unstage_paths_command(paths: &[String]) -> StagingCommand {
    let mut arguments = ["reset", "-q", "HEAD", "--"]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    arguments.extend(paths.iter().map(OsString::from));
    StagingCommand {
        arguments,
        input: None,
        label: "Keep shelf changes unstaged",
        log_label: "git reset -q HEAD -- <shelf paths>",
    }
}

pub async fn check_apply(
    repository_path: &Path,
    patch: &[u8],
    scope: DiffScope,
) -> Result<bool, ShelfError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args(["apply", "--check"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if scope == DiffScope::Index {
        command.arg("--index");
    }
    let mut child = command.spawn().map_err(|_| ShelfError::GitUnavailable)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(patch)
            .await
            .map_err(|_| ShelfError::GitUnavailable)?;
    }
    match tokio::time::timeout(APPLY_CHECK_DEADLINE, child.wait()).await {
        Ok(Ok(status)) => Ok(status.success()),
        Ok(Err(_)) => Err(ShelfError::GitUnavailable),
        Err(_) => {
            let _ = child.kill().await;
            Err(ShelfError::GitTimedOut)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_shelf_metadata_and_patch_bounds() {
        assert_eq!(validate_metadata("  ", ""), Err(ShelfError::InvalidName));
        assert_eq!(
            validate_metadata("shelf\nname", ""),
            Err(ShelfError::InvalidName)
        );
        assert_eq!(
            validate_metadata("valid", &"x".repeat(501)),
            Err(ShelfError::InvalidDescription)
        );
        assert_eq!(validate_metadata("valid", "line one\nline two"), Ok(()));
        assert_eq!(
            validate_patch(b"patch", &[]),
            Err(ShelfError::EmptySelection)
        );
        assert_eq!(
            validate_patch(&vec![0; MAX_PATCH_BYTES + 1], &["a.txt".into()]),
            Err(ShelfError::PatchTooLarge)
        );
    }

    #[test]
    fn shelf_apply_undo_reverses_worktree_or_index_and_worktree_together() {
        let worktree = undo_apply_command(b"patch".to_vec(), DiffScope::WorkingTree);
        let worktree_arguments = worktree
            .arguments
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(worktree_arguments, ["apply", "--reverse"]);
        assert_eq!(worktree.input.as_deref(), Some(&b"patch"[..]));

        let index = undo_apply_command(b"patch".to_vec(), DiffScope::Index);
        let index_arguments = index
            .arguments
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(index_arguments, ["apply", "--reverse", "--index"]);
    }
}
