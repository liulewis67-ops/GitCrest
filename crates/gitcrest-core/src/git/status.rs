use std::path::Path;

use crate::domain::{
    error::WorkflowError,
    workflow::{WorkflowOperation, WorkflowState},
};

use super::process::{run_git, text};

const MAX_PATHS: usize = 200;

pub(crate) async fn read_worktree_state(
    git_program: &str,
    repository_path: &Path,
) -> Result<WorkflowState, WorkflowError> {
    let status = run_git(
        git_program,
        repository_path,
        &[
            "--no-optional-locks".into(),
            "status".into(),
            "--porcelain=v2".into(),
            "-z".into(),
            "--untracked-files=all".into(),
        ],
    )
    .await?;
    let (dirty_paths, omitted_dirty_path_count, conflicted_paths, omitted_conflicted_path_count) =
        parse_status(&status)?;
    let operation = read_operation(git_program, repository_path).await?;
    Ok(WorkflowState {
        dirty_paths,
        omitted_dirty_path_count,
        conflicted_paths,
        omitted_conflicted_path_count,
        operation,
    })
}

pub(crate) async fn read_operation(
    git_program: &str,
    repository_path: &Path,
) -> Result<Option<WorkflowOperation>, WorkflowError> {
    let git_dir = run_git(
        git_program,
        repository_path,
        &["rev-parse".into(), "--git-dir".into()],
    )
    .await?;
    let git_dir = Path::new(text(&git_dir)?);
    let git_dir = if git_dir.is_absolute() {
        git_dir.to_path_buf()
    } else {
        repository_path.join(git_dir)
    };
    for marker in ["rebase-merge", "rebase-apply"] {
        if tokio::fs::metadata(git_dir.join(marker)).await.is_ok() {
            return Ok(Some(WorkflowOperation::Rebase));
        }
    }
    for (marker, operation) in [
        ("MERGE_HEAD", WorkflowOperation::Merge),
        ("CHERRY_PICK_HEAD", WorkflowOperation::CherryPick),
        ("REVERT_HEAD", WorkflowOperation::Revert),
    ] {
        if tokio::fs::metadata(git_dir.join(marker)).await.is_ok() {
            return Ok(Some(operation));
        }
    }
    Ok(None)
}

pub(crate) fn parse_status(
    output: &[u8],
) -> Result<(Vec<String>, u32, Vec<String>, u32), WorkflowError> {
    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut dirty_paths = Vec::new();
    let mut conflicted_paths = Vec::new();
    let mut dirty_count = 0u32;
    let mut conflicted_count = 0u32;
    while let Some(record) = records.next() {
        let value = std::str::from_utf8(record).map_err(|_| WorkflowError::GitFailed)?;
        let (path, conflicted) = if let Some(path) = value.strip_prefix("? ") {
            (path, false)
        } else if value.starts_with("1 ") {
            (
                value
                    .splitn(9, ' ')
                    .nth(8)
                    .ok_or(WorkflowError::GitFailed)?,
                false,
            )
        } else if value.starts_with("2 ") {
            let path = value
                .splitn(10, ' ')
                .nth(9)
                .ok_or(WorkflowError::GitFailed)?;
            let _original_path = records.next();
            (path, false)
        } else if value.starts_with("u ") {
            (
                value
                    .splitn(11, ' ')
                    .nth(10)
                    .ok_or(WorkflowError::GitFailed)?,
                true,
            )
        } else {
            return Err(WorkflowError::GitFailed);
        };
        dirty_count = dirty_count.saturating_add(1);
        if dirty_paths.len() < MAX_PATHS {
            dirty_paths.push(path.to_owned());
        }
        if conflicted {
            conflicted_count = conflicted_count.saturating_add(1);
            if conflicted_paths.len() < MAX_PATHS {
                conflicted_paths.push(path.to_owned());
            }
        }
    }
    Ok((
        dirty_paths,
        dirty_count.saturating_sub(MAX_PATHS as u32),
        conflicted_paths,
        conflicted_count.saturating_sub(MAX_PATHS as u32),
    ))
}
