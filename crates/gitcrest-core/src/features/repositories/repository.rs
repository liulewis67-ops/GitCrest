use std::{
    fmt::Write as _,
    path::{Path, PathBuf},
    process::Stdio,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{fs, process::Command, task};

use crate::{domain::error::RepositoryError, storage::RepositoryStore};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub repo_id: String,
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub state: String,
    pub is_favorite: bool,
    pub last_accessed_at: i64,
    pub availability: String,
}

#[derive(Clone, Default)]
pub struct RepositoryManager {
    store: RepositoryStore,
}

#[derive(Clone, Debug)]
pub struct TaskTarget {
    pub repository_path: PathBuf,
    pub resource_key: String,
}

#[derive(Clone, Debug)]
pub struct HistoryTarget {
    pub repository_path: PathBuf,
    pub head: Option<String>,
}

impl RepositoryManager {
    pub fn store(&self) -> RepositoryStore {
        self.store.clone()
    }

    pub async fn task_target(&self, repo_id: &str) -> Result<TaskTarget, RepositoryError> {
        let store = self.store.clone();
        let repo_id = repo_id.to_owned();
        let repository = task::spawn_blocking(move || store.get(&repo_id))
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .ok_or(RepositoryError::RepositoryNotFound)?;
        let repository_path = PathBuf::from(repository.path);
        fs::metadata(&repository_path)
            .await
            .map_err(map_path_error)?;
        let output = Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(["rev-parse", "--git-common-dir"])
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|_| RepositoryError::GitUnavailable)?;
        if !output.status.success() {
            return Err(RepositoryError::StatusFailed);
        }
        let common_dir = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let common_dir = PathBuf::from(common_dir);
        let common_dir = if common_dir.is_absolute() {
            common_dir
        } else {
            repository_path.join(common_dir)
        };
        let canonical = fs::canonicalize(&common_dir)
            .await
            .map_err(|_| RepositoryError::StatusFailed)?;
        Ok(TaskTarget {
            repository_path,
            resource_key: canonical.to_string_lossy().into_owned(),
        })
    }

    pub async fn history_target(&self, repo_id: &str) -> Result<HistoryTarget, RepositoryError> {
        let store = self.store.clone();
        let repo_id = repo_id.to_owned();
        let repository = task::spawn_blocking(move || store.get(&repo_id))
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .ok_or(RepositoryError::RepositoryNotFound)?;
        let repository_path = PathBuf::from(repository.path);
        fs::metadata(&repository_path)
            .await
            .map_err(map_path_error)?;
        let head = if repository.detached {
            match git_output(&repository_path, ["rev-parse", "--verify", "HEAD"]).await {
                Ok(head) if !head.is_empty() => Some(head),
                Ok(_) | Err(RepositoryError::NotRepository) => None,
                Err(error) => return Err(error),
            }
        } else {
            repository.head
        };
        Ok(HistoryTarget {
            repository_path,
            head,
        })
    }

    pub async fn read_target(&self, repo_id: &str) -> Result<PathBuf, RepositoryError> {
        let store = self.store.clone();
        let repo_id = repo_id.to_owned();
        let repository = task::spawn_blocking(move || store.get(&repo_id))
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .ok_or(RepositoryError::RepositoryNotFound)?;
        let path = PathBuf::from(repository.path);
        fs::metadata(&path).await.map_err(map_path_error)?;
        Ok(path)
    }

    pub async fn open_database(path: PathBuf) -> Result<Self, RepositoryError> {
        let store = task::spawn_blocking(move || RepositoryStore::open(&path))
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)?;
        Ok(Self { store })
    }

    pub async fn open_path(&self, path: &str) -> Result<Repository, RepositoryError> {
        let path = path.trim();
        if path.is_empty() {
            return Err(RepositoryError::InvalidPath);
        }

        let requested_path = PathBuf::from(path);
        let metadata = fs::metadata(&requested_path)
            .await
            .map_err(map_path_error)?;
        if !metadata.is_dir() {
            return Err(RepositoryError::NotRepository);
        }
        let requested_path = fs::canonicalize(&requested_path)
            .await
            .map_err(map_path_error)?;

        let root = git_output(&requested_path, ["rev-parse", "--show-toplevel"]).await?;
        let root = PathBuf::from(root);
        let root = normalize_canonical_path(fs::canonicalize(root).await.map_err(map_path_error)?);

        let head = match git_output(&root, ["rev-parse", "--verify", "HEAD"]).await {
            Ok(head) if !head.is_empty() => Some(head),
            _ => None,
        };
        let branch = match git_output(&root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).await {
            Ok(branch) if !branch.is_empty() => Some(branch),
            _ => None,
        };
        let detached = branch.is_none() && head.is_some();
        let repository = Repository {
            repo_id: stable_repo_id(&root),
            path: root.to_string_lossy().into_owned(),
            head,
            branch,
            detached,
            state: "normal".into(),
            is_favorite: false,
            last_accessed_at: now_ms(),
            availability: "available".into(),
        };

        let store = self.store.clone();
        task::spawn_blocking(move || store.save_opened(repository))
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)
    }

    pub async fn initialize_path(&self, path: &str) -> Result<Repository, RepositoryError> {
        let path = path.trim();
        if path.is_empty() {
            return Err(RepositoryError::InvalidPath);
        }
        let path = PathBuf::from(path);
        let metadata = fs::metadata(&path).await.map_err(map_path_error)?;
        if !metadata.is_dir() {
            return Err(RepositoryError::NotRepository);
        }
        if fs::symlink_metadata(path.join(".git")).await.is_ok() {
            return Err(RepositoryError::AlreadyRepository);
        }
        let path = fs::canonicalize(path).await.map_err(map_path_error)?;
        if git_output(&path, ["rev-parse", "--show-toplevel"])
            .await
            .is_ok()
        {
            return Err(RepositoryError::AlreadyRepository);
        }
        let output = Command::new("git")
            .arg("-C")
            .arg(&path)
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
        if !output.status.success() {
            return Err(
                if String::from_utf8_lossy(&output.stderr)
                    .to_lowercase()
                    .contains("permission")
                {
                    RepositoryError::PathPermissionDenied
                } else {
                    RepositoryError::InitializationFailed
                },
            );
        }
        self.open_path(&path.to_string_lossy()).await
    }

    pub async fn get(&self, repo_id: &str) -> Result<Option<Repository>, RepositoryError> {
        let store = self.store.clone();
        let repo_id = repo_id.to_owned();
        let Some(mut repository) =
            task::spawn_blocking(move || store.mark_opened(&repo_id, now_ms()))
                .await
                .map_err(|_| RepositoryError::StorageUnavailable)?
                .map_err(|_| RepositoryError::StorageUnavailable)?
        else {
            return Ok(None);
        };
        repository.availability = if fs::metadata(&repository.path).await.is_ok() {
            "available"
        } else {
            "missing"
        }
        .into();
        Ok(Some(repository))
    }

    pub async fn refresh_metadata(&self, repo_id: &str) -> Result<Repository, RepositoryError> {
        let store = self.store.clone();
        let repo_id = repo_id.to_owned();
        let repository = task::spawn_blocking(move || store.get(&repo_id))
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .ok_or(RepositoryError::RepositoryNotFound)?;
        self.open_path(&repository.path).await
    }

    pub async fn list(&self) -> Result<Vec<Repository>, RepositoryError> {
        let store = self.store.clone();
        let mut repositories = task::spawn_blocking(move || store.list())
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)?;
        for repository in &mut repositories {
            repository.availability = if fs::metadata(&repository.path).await.is_ok() {
                "available"
            } else {
                "missing"
            }
            .into();
        }
        Ok(repositories)
    }

    pub async fn set_favorite(
        &self,
        repo_id: String,
        favorite: bool,
    ) -> Result<Option<Repository>, RepositoryError> {
        let store = self.store.clone();
        task::spawn_blocking(move || store.set_favorite(&repo_id, favorite))
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)
    }

    pub async fn forget(&self, repo_id: String) -> Result<bool, RepositoryError> {
        let store = self.store.clone();
        task::spawn_blocking(move || store.forget(&repo_id))
            .await
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .map_err(|_| RepositoryError::StorageUnavailable)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn stable_repo_id(root: &Path) -> String {
    let normalized_path = root.to_string_lossy();
    #[cfg(windows)]
    let normalized_path = normalized_path.to_lowercase();

    let digest = Sha256::digest(normalized_path.as_bytes());
    let mut repo_id = String::with_capacity(69);
    repo_id.push_str("repo_");
    for byte in digest {
        let _ = write!(repo_id, "{byte:02x}");
    }
    repo_id
}

#[cfg(windows)]
fn normalize_canonical_path(path: PathBuf) -> PathBuf {
    let path = path.to_string_lossy();
    if let Some(unc_path) = path.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc_path}"))
    } else if let Some(drive_path) = path.strip_prefix(r"\\?\") {
        PathBuf::from(drive_path)
    } else {
        PathBuf::from(path.as_ref())
    }
}

#[cfg(not(windows))]
fn normalize_canonical_path(path: PathBuf) -> PathBuf {
    path
}

fn map_path_error(error: std::io::Error) -> RepositoryError {
    match error.kind() {
        std::io::ErrorKind::NotFound => RepositoryError::PathNotFound,
        std::io::ErrorKind::PermissionDenied => RepositoryError::PathPermissionDenied,
        _ => RepositoryError::PathNotFound,
    }
}

async fn git_output<const N: usize>(
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
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("permission denied") || stderr.contains("access is denied") {
            return Err(RepositoryError::PathPermissionDenied);
        }
        return Err(RepositoryError::NotRepository);
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
    };

    use super::*;

    struct GitFixture {
        directory: tempfile::TempDir,
        root: PathBuf,
    }

    impl GitFixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join("repo");
            fs::create_dir(&root).unwrap();
            git(&root, &["init", "--quiet"]);
            git(&root, &["config", "user.name", "GitCrest Test"]);
            git(
                &root,
                &["config", "user.email", "gitcrest-test@example.invalid"],
            );
            Self { directory, root }
        }

        fn commit(&self) {
            fs::write(self.root.join("README.md"), "fixture\n").unwrap();
            git(&self.root, &["add", "README.md"]);
            git(&self.root, &["commit", "--quiet", "-m", "fixture"]);
        }
    }

    fn git(path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
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
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    #[tokio::test]
    async fn opens_normal_and_empty_repositories_with_stable_ids() {
        let fixture = GitFixture::new();
        fixture.commit();
        let manager = RepositoryManager::default();

        let opened = manager
            .open_path(fixture.root.to_str().unwrap())
            .await
            .unwrap();
        let reopened = manager
            .open_path(fixture.root.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(opened.repo_id, reopened.repo_id);
        let accessed = manager.get(&opened.repo_id).await.unwrap().unwrap();
        assert!(accessed.last_accessed_at >= reopened.last_accessed_at);
        assert!(opened.repo_id.starts_with("repo_"));
        assert_eq!(Path::new(&opened.path), fixture.root.as_path());
        assert!(opened.head.as_deref().is_some_and(|head| head.len() >= 40));
        assert!(opened.branch.is_some());
        assert!(!opened.detached);

        let empty = tempfile::tempdir().unwrap();
        git(empty.path(), &["init", "--quiet"]);
        let opened_empty = manager
            .open_path(empty.path().to_str().unwrap())
            .await
            .unwrap();
        assert!(opened_empty.head.is_none());
        assert!(opened_empty.branch.is_some());
        assert!(!opened_empty.detached);
    }

    #[tokio::test]
    async fn identifies_detached_head() {
        let fixture = GitFixture::new();
        fixture.commit();
        git(&fixture.root, &["checkout", "--quiet", "--detach"]);

        let repository = RepositoryManager::default()
            .open_path(fixture.root.to_str().unwrap())
            .await
            .unwrap();

        assert!(repository.head.is_some());
        assert!(repository.branch.is_none());
        assert!(repository.detached);
    }

    #[tokio::test]
    async fn opens_a_git_worktree_from_its_git_file_path() {
        let fixture = GitFixture::new();
        fixture.commit();
        let worktree = fixture.directory.path().join("worktree");
        git(
            &fixture.root,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "feature",
                worktree.to_str().unwrap(),
            ],
        );
        assert!(worktree.join(".git").is_file());

        let manager = RepositoryManager::default();
        let common_repository = manager
            .open_path(fixture.root.to_str().unwrap())
            .await
            .unwrap();
        let repository = manager.open_path(worktree.to_str().unwrap()).await.unwrap();
        assert_eq!(Path::new(&repository.path), worktree.as_path());
        assert_eq!(repository.branch.as_deref(), Some("feature"));
        assert_ne!(
            repository.repo_id,
            stable_repo_id(&normalize_canonical_path(
                fixture.root.canonicalize().unwrap()
            ))
        );
        let common_target = manager
            .task_target(&common_repository.repo_id)
            .await
            .unwrap();
        let worktree_target = manager.task_target(&repository.repo_id).await.unwrap();
        assert_eq!(common_target.resource_key, worktree_target.resource_key);
    }

    #[tokio::test]
    async fn distinguishes_missing_paths_non_repositories_and_invalid_input() {
        let manager = RepositoryManager::default();
        let missing = tempfile::tempdir().unwrap().path().join("missing");
        assert_eq!(
            manager.open_path(missing.to_str().unwrap()).await,
            Err(RepositoryError::PathNotFound)
        );

        let plain_directory = tempfile::tempdir().unwrap();
        assert_eq!(
            manager
                .open_path(plain_directory.path().to_str().unwrap())
                .await,
            Err(RepositoryError::NotRepository)
        );
        assert_eq!(
            manager.open_path("   ").await,
            Err(RepositoryError::InvalidPath)
        );
    }

    #[tokio::test]
    async fn initializes_only_an_uninitialized_selected_folder() {
        let directory = tempfile::tempdir().unwrap();
        let new_folder = directory.path().join("new-project");
        fs::create_dir(&new_folder).unwrap();
        fs::write(new_folder.join("notes.txt"), "keep this file\n").unwrap();
        let manager = RepositoryManager::default();

        let repository = manager
            .initialize_path(new_folder.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(Path::new(&repository.path), new_folder.as_path());
        assert_eq!(
            fs::read_to_string(new_folder.join("notes.txt")).unwrap(),
            "keep this file\n"
        );
        assert!(new_folder.join(".git").is_dir());
        assert_eq!(
            manager.initialize_path(new_folder.to_str().unwrap()).await,
            Err(RepositoryError::AlreadyRepository)
        );

        let nested_folder = new_folder.join("nested");
        fs::create_dir(&nested_folder).unwrap();
        assert_eq!(
            manager
                .initialize_path(nested_folder.to_str().unwrap())
                .await,
            Err(RepositoryError::AlreadyRepository)
        );
        assert!(!nested_folder.join(".git").exists());
    }

    #[tokio::test]
    async fn repository_list_marks_moved_paths_as_recoverable_missing_entries() {
        let directory = tempfile::tempdir().unwrap();
        let repo_path = directory.path().join("repo");
        fs::create_dir(&repo_path).unwrap();
        git(&repo_path, &["init", "--quiet"]);
        let database = directory.path().join("app-data").join("gitcrest.sqlite");
        let manager = RepositoryManager::open_database(database).await.unwrap();
        let opened = manager
            .open_path(repo_path.to_str().unwrap())
            .await
            .unwrap();
        manager
            .set_favorite(opened.repo_id.clone(), true)
            .await
            .unwrap();
        fs::rename(&repo_path, directory.path().join("moved")).unwrap();

        let listed = manager.list().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].availability, "missing");
        assert!(listed[0].is_favorite);
    }

    #[tokio::test]
    async fn full_status_snapshot_groups_changes_and_refreshes_external_git_edits() {
        let fixture = GitFixture::new();
        fixture.commit();
        fs::write(fixture.root.join("rename source.txt"), "rename me\n").unwrap();
        fs::write(fixture.root.join("deleted.txt"), "remove me\n").unwrap();
        git(&fixture.root, &["add", "."]);
        git(
            &fixture.root,
            &["commit", "--quiet", "-m", "add tracked fixtures"],
        );
        fs::write(fixture.root.join(".gitignore"), "ignored.log\n").unwrap();
        git(&fixture.root, &["add", ".gitignore"]);
        git(
            &fixture.root,
            &["commit", "--quiet", "-m", "ignore fixture"],
        );

        fs::write(fixture.root.join("README.md"), "staged version\n").unwrap();
        git(&fixture.root, &["add", "README.md"]);
        fs::write(
            fixture.root.join("README.md"),
            "staged version\nunstaged version\n",
        )
        .unwrap();
        git(
            &fixture.root,
            &["mv", "rename source.txt", "renamed file.txt"],
        );
        fs::remove_file(fixture.root.join("deleted.txt")).unwrap();
        fs::write(fixture.root.join("untracked file.txt"), "new\n").unwrap();
        fs::write(fixture.root.join("ignored.log"), "ignored\n").unwrap();

        let manager = RepositoryManager::default();
        let repository = manager
            .open_path(fixture.root.to_str().unwrap())
            .await
            .unwrap();
        let status_service = crate::features::status::StatusService::new(manager.clone());
        let snapshot = status_service.snapshot(&repository.repo_id).await.unwrap();
        let staged_and_unstaged = snapshot
            .files
            .iter()
            .find(|file| file.path == "README.md")
            .unwrap();
        assert!(staged_and_unstaged
            .categories
            .contains(&crate::domain::status::ChangeCategory::Staged));
        assert!(staged_and_unstaged
            .categories
            .contains(&crate::domain::status::ChangeCategory::Unstaged));
        assert!(snapshot.files.iter().any(|file| file.kind
            == crate::domain::status::ChangeKind::Renamed
            && file.original_path.as_deref() == Some("rename source.txt")));
        assert!(snapshot.files.iter().any(|file| file.kind
            == crate::domain::status::ChangeKind::Deleted
            && file.path == "deleted.txt"));
        assert!(snapshot.files.iter().any(|file| file.kind
            == crate::domain::status::ChangeKind::Untracked
            && file.path == "untracked file.txt"));
        assert!(snapshot.files.iter().any(|file| file.kind
            == crate::domain::status::ChangeKind::Ignored
            && file.path == "ignored.log"));

        fs::write(fixture.root.join("later.txt"), "external edit\n").unwrap();
        let refreshed = status_service.snapshot(&repository.repo_id).await.unwrap();
        assert!(refreshed.refreshed_at_ms >= snapshot.refreshed_at_ms);
        assert!(refreshed.files.iter().any(|file| file.path == "later.txt"));
    }

    #[tokio::test]
    async fn full_status_snapshot_reports_merge_conflicts() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("conflict-repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet"]);
        git(&root, &["config", "user.name", "GitCrest Test"]);
        git(
            &root,
            &["config", "user.email", "gitcrest-test@example.invalid"],
        );
        fs::write(root.join("conflict.txt"), "base\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "--quiet", "-m", "base"]);
        let base = git(&root, &["rev-parse", "HEAD"]);
        git(&root, &["checkout", "--quiet", "-b", "ours"]);
        fs::write(root.join("conflict.txt"), "ours\n").unwrap();
        git(&root, &["commit", "--quiet", "-am", "ours"]);
        git(&root, &["checkout", "--quiet", "-b", "theirs", &base]);
        fs::write(root.join("conflict.txt"), "theirs\n").unwrap();
        git(&root, &["commit", "--quiet", "-am", "theirs"]);
        git(&root, &["checkout", "--quiet", "ours"]);
        let conflict = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["merge", "theirs"])
            .output()
            .unwrap();
        assert!(!conflict.status.success());

        let manager = RepositoryManager::default();
        let repository = manager.open_path(root.to_str().unwrap()).await.unwrap();
        let snapshot = crate::features::status::StatusService::new(manager.clone())
            .snapshot(&repository.repo_id)
            .await
            .unwrap();
        let conflicted = snapshot
            .files
            .iter()
            .find(|file| file.path == "conflict.txt")
            .unwrap();
        assert_eq!(
            conflicted.kind,
            crate::domain::status::ChangeKind::Conflicted
        );
        assert_eq!(
            conflicted.categories,
            [crate::domain::status::ChangeCategory::Conflicted]
        );
    }
}
