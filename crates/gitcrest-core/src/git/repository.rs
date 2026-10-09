use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

use tempfile::Builder;
use tokio::{fs, process::Command};

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
        Box::pin(async move { Self::initialize_staged(repository_path, None).await })
    }
}

impl GitRepositoryAdapter {
    async fn initialize_staged(
        repository_path: &Path,
        template_directory: Option<&Path>,
    ) -> Result<(), RepositoryError> {
        Self::ensure_git_directory_absent(repository_path).await?;
        let staging = Builder::new()
            .prefix(".gitcrest-init-")
            .tempdir_in(repository_path)
            .map_err(map_initialization_io_error)?;
        Self::run_init(repository_path, staging.path(), template_directory).await?;

        Self::ensure_git_directory_absent(repository_path).await?;
        let target_git_directory = repository_path.join(".git");
        fs::rename(staging.path().join(".git"), target_git_directory)
            .await
            .map_err(map_initialization_io_error)?;
        Ok(())
    }

    async fn ensure_git_directory_absent(repository_path: &Path) -> Result<(), RepositoryError> {
        match fs::symlink_metadata(repository_path.join(".git")).await {
            Ok(_) => Err(RepositoryError::AlreadyRepository),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(map_initialization_io_error(error)),
        }
    }

    async fn run_init(
        repository_path: &Path,
        target_directory: &Path,
        template_directory: Option<&Path>,
    ) -> Result<(), RepositoryError> {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(repository_path)
            .args(["init", "--quiet"]);
        if let Some(template_directory) = template_directory {
            command.arg("--template").arg(template_directory);
        }
        let output = command
            .arg(target_directory)
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
    }

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

fn map_initialization_io_error(error: std::io::Error) -> RepositoryError {
    match error.kind() {
        std::io::ErrorKind::AlreadyExists => RepositoryError::AlreadyRepository,
        std::io::ErrorKind::PermissionDenied => RepositoryError::PathPermissionDenied,
        _ => RepositoryError::InitializationFailed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn failed_template_initialization_leaves_no_git_metadata_or_staging_directory() {
        let project = tempfile::tempdir().unwrap();
        let template = tempfile::tempdir().unwrap();
        std::fs::write(
            template.path().join("config"),
            "not a valid git config line",
        )
        .unwrap();

        let result =
            GitRepositoryAdapter::initialize_staged(project.path(), Some(template.path())).await;

        assert_eq!(result, Err(RepositoryError::InitializationFailed));
        assert!(!project.path().join(".git").exists());
        assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn refuses_to_replace_existing_git_metadata() {
        let project = tempfile::tempdir().unwrap();
        let git_directory = project.path().join(".git");
        std::fs::create_dir(&git_directory).unwrap();
        std::fs::write(git_directory.join("owned-marker"), "keep").unwrap();

        let result = GitRepositoryAdapter::initialize_staged(project.path(), None).await;

        assert_eq!(result, Err(RepositoryError::AlreadyRepository));
        assert_eq!(
            std::fs::read_to_string(git_directory.join("owned-marker")).unwrap(),
            "keep"
        );
        assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 1);
    }
}
