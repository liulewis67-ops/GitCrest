use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

use tokio::process::Command;

use crate::{
    domain::error::RepositoryError,
    ports::git::{RepositoryGitFuture, RepositoryGitPort},
};

#[derive(Clone, Copy, Default)]
pub(crate) struct GitRepositoryAdapter;

impl RepositoryGitPort for GitRepositoryAdapter {
    fn worktree_root<'a>(&'a self, path: &'a Path) -> RepositoryGitFuture<'a, PathBuf> {
        Box::pin(async move {
            let root = self
                .git_output(path, ["rev-parse", "--show-toplevel"])
                .await?;
            Ok(PathBuf::from(root))
        })
    }

    fn head_oid<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RepositoryGitFuture<'a, Option<String>> {
        Box::pin(async move {
            match self
                .git_output(repository_path, ["rev-parse", "--verify", "HEAD"])
                .await
            {
                Ok(head) if !head.is_empty() => Ok(Some(head)),
                Ok(_) | Err(RepositoryError::NotRepository) => Ok(None),
                Err(error) => Err(error),
            }
        })
    }

    fn current_branch<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RepositoryGitFuture<'a, Option<String>> {
        Box::pin(async move {
            match self
                .git_output(
                    repository_path,
                    ["symbolic-ref", "--quiet", "--short", "HEAD"],
                )
                .await
            {
                Ok(branch) if !branch.is_empty() => Ok(Some(branch)),
                Ok(_) | Err(RepositoryError::NotRepository) => Ok(None),
                Err(error) => Err(error),
            }
        })
    }

    fn common_dir<'a>(&'a self, repository_path: &'a Path) -> RepositoryGitFuture<'a, PathBuf> {
        Box::pin(async move {
            self.git_output(repository_path, ["rev-parse", "--git-common-dir"])
                .await
                .map(PathBuf::from)
                .map_err(|error| match error {
                    RepositoryError::NotRepository => RepositoryError::StatusFailed,
                    error => error,
                })
        })
    }

    fn initialize<'a>(&'a self, repository_path: &'a Path) -> RepositoryGitFuture<'a, ()> {
        Box::pin(async move {
            let output = Command::new("git")
                .arg("-C")
                .arg(repository_path)
                .args(["init", "--quiet"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .output()
                .await
                .map_err(|error| match error.kind() {
                    std::io::ErrorKind::NotFound => RepositoryError::GitUnavailable,
                    std::io::ErrorKind::PermissionDenied => RepositoryError::PathPermissionDenied,
                    _ => RepositoryError::GitUnavailable,
                })?;
            if output.status.success() {
                return Ok(());
            }
            if String::from_utf8_lossy(&output.stderr)
                .to_ascii_lowercase()
                .contains("permission")
            {
                Err(RepositoryError::PathPermissionDenied)
            } else {
                Err(RepositoryError::InitializationFailed)
            }
        })
    }
}

impl GitRepositoryAdapter {
    async fn git_output<const N: usize>(
        &self,
        path: &Path,
        args: [&str; N],
    ) -> Result<String, RepositoryError> {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => RepositoryError::GitUnavailable,
                std::io::ErrorKind::PermissionDenied => RepositoryError::PathPermissionDenied,
                _ => RepositoryError::GitUnavailable,
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
            return if stderr.contains("permission denied") || stderr.contains("access is denied") {
                Err(RepositoryError::PathPermissionDenied)
            } else {
                Err(RepositoryError::NotRepository)
            };
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }
}
