use std::{path::Path, process::Stdio, time::Duration};

use tokio::{io::AsyncWriteExt, process::Command};

use crate::{
    domain::{diff::DiffScope, error::GitAdapterError},
    ports::shelves::{ShelfPatchCheckFuture, ShelfPatchCheckPort},
};

use super::command::GitCommandService;

const SHELF_PATCH_CHECK_DEADLINE: Duration = Duration::from_secs(10);

/// Reconstruct both sides without touching the user's index or working tree.
pub(super) fn shelf_merge_trees(
    repository_path: &Path,
    ancestor_index: &Path,
    patch: &[u8],
) -> Result<(String, String, String), crate::execution::TaskFailure> {
    let prepare = || -> Result<_, git2::Error> {
        let repository = git2::Repository::open(repository_path)?;
        let mut ancestor = git2::Index::open(ancestor_index)?;
        let base = repository.find_tree(ancestor.write_tree_to(&repository)?)?;
        let diff = git2::Diff::from_buffer(patch)?;
        let mut saved = repository.apply_to_tree(&base, &diff, None)?;
        let saved = saved.write_tree_to(&repository)?;
        let current = repository.index()?.write_tree()?;
        Ok((
            base.id().to_string(),
            current.to_string(),
            saved.to_string(),
        ))
    };
    prepare().map_err(|error| {
        crate::execution::TaskFailure::Failed(format!(
            "The shelf merge could not be prepared: {error}. The shelf was retained."
        ))
    })
}

/// A modify/delete conflict needs the saved side visible in the working tree.
pub(super) fn shelf_deleted_conflict_paths(
    repository_path: &Path,
) -> Result<Vec<u8>, crate::execution::TaskFailure> {
    let read = || -> Result<Vec<u8>, git2::Error> {
        let repository = git2::Repository::open(repository_path)?;
        let index = repository.index()?;
        let mut paths = Vec::new();
        for conflict in index.conflicts()? {
            let conflict = conflict?;
            if conflict.our.is_none() {
                if let Some(saved) = conflict.their {
                    paths.extend_from_slice(&saved.path);
                    paths.push(0);
                }
            }
        }
        Ok(paths)
    };
    read().map_err(|error| {
        crate::execution::TaskFailure::Failed(format!(
            "The shelf conflict files could not be inspected: {error}. The shelf was retained."
        ))
    })
}

impl ShelfPatchCheckPort for GitCommandService {
    fn check_shelf_patch<'a>(
        &'a self,
        repository_path: &'a Path,
        patch: &'a [u8],
        scope: DiffScope,
    ) -> ShelfPatchCheckFuture<'a, bool> {
        Box::pin(async move {
            let mut command = Command::new(&self.git_program);
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
            let mut child = command.spawn().map_err(|_| GitAdapterError::Unavailable)?;
            let mut stdin = child.stdin.take().ok_or(GitAdapterError::Failed)?;
            stdin
                .write_all(patch)
                .await
                .map_err(|_| GitAdapterError::Unavailable)?;
            drop(stdin);
            match tokio::time::timeout(SHELF_PATCH_CHECK_DEADLINE, child.wait()).await {
                Ok(Ok(status)) => Ok(status.success()),
                Ok(Err(_)) => Err(GitAdapterError::Unavailable),
                Err(_) => {
                    let _ = child.kill().await;
                    Err(GitAdapterError::TimedOut)
                }
            }
        })
    }
}
