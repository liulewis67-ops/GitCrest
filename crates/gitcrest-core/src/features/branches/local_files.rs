//! Opt-in copying of Git-ignored local files (for example .env) into a new worktree.
//!
//! Nothing is copied unless the caller names the files, and only small regular files that Git reports as
//! ignored and untracked, inside the repository, can be named.

use std::path::{Component, Path, PathBuf};

use crate::git::command::GitCommandService;

const MAX_COPY_FILE_BYTES: u64 = 256 * 1024;
const MAX_LISTED_FILES: usize = 100;

pub(super) struct CopyableFiles {
    pub(super) files: Vec<(String, u64)>,
    /// Ignored folders, large files and files beyond the listing limit that are not offered.
    pub(super) omitted: usize,
}

fn is_plain_relative(path: &str) -> bool {
    let candidate = Path::new(path);
    !path.is_empty()
        && !candidate.is_absolute()
        && candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// Lists small ignored files in the repository that can be copied into a new worktree.
pub(super) async fn list_copyable_files(
    git: &GitCommandService,
    repository_path: &Path,
) -> Result<CopyableFiles, ()> {
    let ignored = git
        .list_ignored_paths(repository_path)
        .await
        .map_err(|_| ())?;
    let mut files = Vec::new();
    let mut omitted = 0;
    for entry in ignored {
        if entry.ends_with('/') || !is_plain_relative(&entry) {
            omitted += 1;
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(repository_path.join(&entry)) else {
            continue;
        };
        if !metadata.is_file()
            || metadata.len() > MAX_COPY_FILE_BYTES
            || files.len() >= MAX_LISTED_FILES
        {
            omitted += 1;
            continue;
        }
        files.push((entry, metadata.len()));
    }
    files.sort();
    Ok(CopyableFiles { files, omitted })
}

/// Returns the requested files that are not on the copyable list.
pub(super) async fn rejected_copy_requests(
    git: &GitCommandService,
    repository_path: &Path,
    requested: &[String],
) -> Result<Vec<String>, ()> {
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    let allowed = list_copyable_files(git, repository_path).await?;
    Ok(requested
        .iter()
        .filter(|path| {
            !allowed
                .files
                .iter()
                .any(|(candidate, _)| candidate == *path)
        })
        .cloned()
        .collect())
}

/// Copies the named files into the destination folder, never overwriting. Returns how many were
/// copied and a description of each failure.
pub(super) fn copy_files(
    repository_path: &Path,
    destination_root: &Path,
    files: &[String],
) -> (usize, Vec<String>) {
    let mut copied = 0;
    let mut failures = Vec::new();
    for relative in files {
        if !is_plain_relative(relative) {
            failures.push(format!("{relative}: not a plain relative path"));
            continue;
        }
        let source: PathBuf = repository_path.join(relative);
        let destination: PathBuf = destination_root.join(relative);
        if destination.exists() {
            failures.push(format!("{relative}: already exists in the worktree"));
            continue;
        }
        let result = destination
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::copy(&source, &destination).map(|_| ()));
        match result {
            Ok(()) => copied += 1,
            Err(error) => failures.push(format!("{relative}: {error}")),
        }
    }
    (copied, failures)
}
