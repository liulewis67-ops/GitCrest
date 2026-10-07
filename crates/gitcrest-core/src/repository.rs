use std::{
    collections::BTreeMap,
    fmt::Write as _,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{fs, process::Command, sync::RwLock};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub repo_id: String,
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub state: &'static str,
}

#[derive(Clone, Default)]
pub struct RepositoryManager {
    repositories: Arc<RwLock<BTreeMap<String, Repository>>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RepositoryError {
    InvalidPath,
    PathNotFound,
    PathPermissionDenied,
    NotRepository,
    GitUnavailable,
}

impl RepositoryManager {
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
            state: "normal",
        };

        self.repositories
            .write()
            .await
            .insert(repository.repo_id.clone(), repository.clone());
        Ok(repository)
    }

    pub async fn get(&self, repo_id: &str) -> Option<Repository> {
        self.repositories.read().await.get(repo_id).cloned()
    }

    pub async fn list(&self) -> Vec<Repository> {
        self.repositories.read().await.values().cloned().collect()
    }
}

fn stable_repo_id(root: &Path) -> String {
    let mut normalized_path = root.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        normalized_path = normalized_path.to_lowercase();
    }

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

        let repository = RepositoryManager::default()
            .open_path(worktree.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(Path::new(&repository.path), worktree.as_path());
        assert_eq!(repository.branch.as_deref(), Some("feature"));
        assert_ne!(
            repository.repo_id,
            stable_repo_id(&normalize_canonical_path(
                fixture.root.canonicalize().unwrap()
            ))
        );
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
}
