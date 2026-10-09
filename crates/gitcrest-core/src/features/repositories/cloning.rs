use std::path::{Component, Path, PathBuf};

use tokio::fs;

use crate::{
    features::{
        repositories::repository::RepositoryManager,
        tasks::{TaskFailure, TaskService, TaskSnapshot, TaskSubmitError},
    },
    git::command::GitCommandService,
};

#[derive(Debug, PartialEq, Eq)]
pub enum CloneError {
    InvalidRemote,
    InvalidTarget,
    ParentNotFound,
    ParentAccessDenied,
    DestinationExists,
    Queue(TaskSubmitError),
}

#[derive(Clone)]
pub struct CloneService {
    tasks: TaskService,
    git: GitCommandService,
    repositories: RepositoryManager,
}

impl CloneService {
    pub fn new(
        tasks: TaskService,
        git: GitCommandService,
        repositories: RepositoryManager,
    ) -> Self {
        Self {
            tasks,
            git,
            repositories,
        }
    }

    pub async fn queue(
        &self,
        remote_url: String,
        parent_path: String,
        directory_name: String,
    ) -> Result<TaskSnapshot, CloneError> {
        validate_remote_url(&remote_url)?;
        validate_directory_name(&directory_name)?;
        let parent = fs::canonicalize(parent_path)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => CloneError::ParentNotFound,
                std::io::ErrorKind::PermissionDenied => CloneError::ParentAccessDenied,
                _ => CloneError::InvalidTarget,
            })?;
        if !fs::metadata(&parent)
            .await
            .map_err(|_| CloneError::InvalidTarget)?
            .is_dir()
        {
            return Err(CloneError::InvalidTarget);
        }

        let destination = parent.join(&directory_name);
        if path_exists(&destination).await? {
            return Err(CloneError::DestinationExists);
        }
        let resource_key = destination.to_string_lossy().into_owned();
        let destination_for_task = destination.clone();
        let parent_for_task = parent.clone();
        let remote_for_task = remote_url;
        let git = self.git.clone();
        let repositories = self.repositories.clone();
        let target_path = destination.to_string_lossy().into_owned();
        self.tasks
            .submit(
                None,
                Some(target_path),
                resource_key,
                "clone",
                move |context| async move {
                    if path_exists(&destination_for_task).await.unwrap_or(true) {
                        return Err(TaskFailure::Failed(
                            "The selected destination appeared before cloning began; it was preserved.".into(),
                        ));
                    }
                    let stage = parent_for_task.join(format!(
                        ".gitcrest-clone-{}.partial",
                        context.task_id()
                    ));
                    if path_exists(&stage).await.unwrap_or(true) {
                        return Err(TaskFailure::Failed(
                            "A temporary clone destination already exists.".into(),
                        ));
                    }
                    let git_stage = git_compatible_path(&stage);
                    let git_parent = git_compatible_path(&parent_for_task);
                    if let Err(error) = git
                        .execute_clone(&remote_for_task, &git_stage, &git_parent, context.clone())
                        .await
                    {
                        cleanup_stage(&stage).await;
                        return Err(error);
                    }
                    if context.cancellation_requested() {
                        cleanup_stage(&stage).await;
                        return Err(TaskFailure::Cancelled);
                    }
                    if path_exists(&destination_for_task).await.unwrap_or(true) {
                        cleanup_stage(&stage).await;
                        return Err(TaskFailure::Failed(
                            "The destination was created while cloning. The existing folder was preserved.".into(),
                        ));
                    }
                    if fs::rename(&stage, &destination_for_task).await.is_err() {
                        cleanup_stage(&stage).await;
                        return Err(TaskFailure::Failed(
                            "Git cloned the repository, but it could not be moved into the selected destination.".into(),
                        ));
                    }
                    let repository = repositories
                        .open_path(destination_for_task.to_string_lossy().as_ref())
                        .await
                        .map_err(|_| {
                            TaskFailure::Failed(
                                "Clone completed, but the repository could not be registered. Open the destination folder to continue.".into(),
                            )
                        })?;
                    Ok(Some(repository.repo_id))
                },
            )
            .await
            .map_err(CloneError::Queue)
    }
}

#[cfg(windows)]
fn git_compatible_path(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\{unc}"))
    } else if let Some(normal) = value.strip_prefix(r"\\?\") {
        PathBuf::from(normal)
    } else {
        path.to_path_buf()
    }
}

#[cfg(not(windows))]
fn git_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

async fn path_exists(path: &Path) -> Result<bool, CloneError> {
    match fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(CloneError::InvalidTarget),
    }
}

async fn cleanup_stage(path: &Path) {
    let Ok(metadata) = fs::symlink_metadata(path).await else {
        return;
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        let _ = fs::remove_file(path).await;
    } else if metadata.is_dir() {
        let _ = fs::remove_dir_all(path).await;
    }
}

fn validate_directory_name(name: &str) -> Result<(), CloneError> {
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(char::is_control)
        || !matches!(
            Path::new(name).components().next(),
            Some(Component::Normal(_))
        )
        || Path::new(name).components().count() != 1
    {
        return Err(CloneError::InvalidTarget);
    }
    #[cfg(windows)]
    if name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|character| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        || is_reserved_windows_name(name)
    {
        return Err(CloneError::InvalidTarget);
    }
    Ok(())
}

#[cfg(windows)]
fn is_reserved_windows_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
}

pub(crate) fn validate_remote_url(remote: &str) -> Result<(), CloneError> {
    if !crate::domain::remote::is_safe_remote_url(remote) {
        return Err(CloneError::InvalidRemote);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(path: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn accepts_https_ssh_and_local_fixture_remotes_but_rejects_embedded_secrets() {
        assert!(validate_remote_url("https://example.test/owner/repo.git").is_ok());
        assert!(validate_remote_url("ssh://git@example.test/owner/repo.git").is_ok());
        assert!(validate_remote_url("git@example.test:owner/repo.git").is_ok());
        assert!(validate_remote_url("file:///tmp/remote.git").is_ok());
        assert_eq!(
            validate_remote_url("https://user:secret@example.test/repo"),
            Err(CloneError::InvalidRemote)
        );
        assert_eq!(
            validate_remote_url("https://example.test/repo?access_token=secret"),
            Err(CloneError::InvalidRemote)
        );
        assert_eq!(
            validate_remote_url("--upload-pack=bad"),
            Err(CloneError::InvalidRemote)
        );
    }

    #[test]
    fn only_accepts_a_single_safe_destination_component() {
        assert!(validate_directory_name("GitCrest").is_ok());
        assert_eq!(
            validate_directory_name("../outside"),
            Err(CloneError::InvalidTarget)
        );
        assert_eq!(
            validate_directory_name("nested/path"),
            Err(CloneError::InvalidTarget)
        );
    }

    #[tokio::test]
    async fn failed_clone_cleans_staging_and_retry_registers_and_opens_repository() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("projects");
        let seed = root.path().join("seed");
        let bare = root.path().join("remote.git");
        fs::create_dir(&parent).await.unwrap();
        fs::create_dir(&seed).await.unwrap();
        git(&seed, &["init", "--quiet"]);
        git(&seed, &["config", "user.name", "GitCrest Test"]);
        git(
            &seed,
            &["config", "user.email", "gitcrest-test@example.invalid"],
        );
        fs::write(seed.join("README.md"), "clone fixture\n")
            .await
            .unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "--quiet", "-m", "fixture"]);
        let output = std::process::Command::new("git")
            .args(["clone", "--bare", "--quiet"])
            .arg(&seed)
            .arg(&bare)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );

        let repositories = RepositoryManager::default();
        let tasks = TaskService::default();
        let clones = CloneService::new(
            tasks.clone(),
            GitCommandService::default(),
            repositories.clone(),
        );
        let invalid_remote = format!("file://{}", root.path().join("missing.git").display());
        let failed = clones
            .queue(
                invalid_remote,
                parent.to_string_lossy().into_owned(),
                "retry-me".into(),
            )
            .await
            .unwrap();
        let failed = wait_for_terminal(&tasks, &failed.task_id).await;
        assert_eq!(failed.status, crate::features::tasks::TaskStatus::Failed);
        assert!(!parent.join("retry-me").exists());
        assert!(!parent
            .join(format!(".gitcrest-clone-{}.partial", failed.task_id))
            .exists());
        assert!(repositories.list().await.unwrap().is_empty());

        let unused_port = std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let unreachable = clones
            .queue(
                format!("https://127.0.0.1:{unused_port}/not-running.git"),
                parent.to_string_lossy().into_owned(),
                "network-retry".into(),
            )
            .await
            .unwrap();
        let unreachable = wait_for_terminal(&tasks, &unreachable.task_id).await;
        assert_eq!(
            unreachable.status,
            crate::features::tasks::TaskStatus::Failed
        );
        assert_eq!(
            unreachable.error_category,
            Some(crate::domain::task::TaskErrorCategory::Network),
            "{:?}",
            unreachable.logs
        );
        assert!(!parent.join("network-retry").exists());
        assert!(!parent
            .join(format!(".gitcrest-clone-{}.partial", unreachable.task_id))
            .exists());

        let remote = format!("file://{}", bare.display());
        let retried = clones
            .queue(
                remote,
                parent.to_string_lossy().into_owned(),
                "retry-me".into(),
            )
            .await
            .unwrap();
        let retried = wait_for_terminal(&tasks, &retried.task_id).await;
        assert_eq!(
            retried.status,
            crate::features::tasks::TaskStatus::Succeeded,
            "message={:?}, logs={:?}",
            retried.message,
            retried.logs
        );
        let repo_id = retried
            .result_repo_id
            .as_deref()
            .expect("successful clone has a registered repo id");
        let repository = repositories
            .get(repo_id)
            .await
            .unwrap()
            .expect("clone is registered");
        assert_eq!(repository.path, parent.join("retry-me").to_string_lossy());
        let status = crate::features::status::StatusService::new(repositories.clone())
            .snapshot(repo_id)
            .await
            .unwrap();
        assert_eq!(status.files.len(), 0);
        assert!(!parent
            .join(format!(".gitcrest-clone-{}.partial", retried.task_id))
            .exists());

        let blockers = (0..4).map(|index| {
            let tasks = tasks.clone();
            async move {
                tasks
                    .submit(
                        None,
                        None,
                        format!("clone-cancel-blocker-{index}"),
                        "test-blocker",
                        |mut context| async move {
                            context.cancelled().await;
                            Err(TaskFailure::Cancelled)
                        },
                    )
                    .await
                    .unwrap()
            }
        });
        let blockers = futures_util::future::join_all(blockers).await;
        for blocker in &blockers {
            for _ in 0..100 {
                if tasks.get(&blocker.task_id).await.unwrap().status
                    == crate::features::tasks::TaskStatus::Running
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
        let cancelled = clones
            .queue(
                format!("file://{}", bare.display()),
                parent.to_string_lossy().into_owned(),
                "cancel-me".into(),
            )
            .await
            .unwrap();
        tasks.cancel(&cancelled.task_id).await.unwrap();
        let cancelled = wait_for_terminal(&tasks, &cancelled.task_id).await;
        assert_eq!(
            cancelled.status,
            crate::features::tasks::TaskStatus::Cancelled
        );
        assert!(!parent.join("cancel-me").exists());
        assert!(!parent
            .join(format!(".gitcrest-clone-{}.partial", cancelled.task_id))
            .exists());
        for blocker in blockers {
            tasks.cancel(&blocker.task_id).await.unwrap();
            wait_for_terminal(&tasks, &blocker.task_id).await;
        }
    }

    async fn wait_for_terminal(tasks: &TaskService, task_id: &str) -> TaskSnapshot {
        for _ in 0..200 {
            let task = tasks.get(task_id).await.unwrap();
            if matches!(
                task.status,
                crate::features::tasks::TaskStatus::Succeeded
                    | crate::features::tasks::TaskStatus::Failed
                    | crate::features::tasks::TaskStatus::Cancelled
            ) {
                return task;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("clone task did not reach a terminal state");
    }
}
