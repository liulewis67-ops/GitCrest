use std::{path::Path, sync::Arc};

use serde::Serialize;

use crate::{
    domain::{
        branch::{is_branch_name_syntactically_valid, BranchReference},
        error::GitAdapterError,
    },
    ports::{branch_favorites::BranchFavoriteStorePort, branches::BranchGitPort},
};

#[cfg(test)]
use crate::git::refs::GitBranchAdapter;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSnapshot {
    pub repo_id: String,
    pub current: Option<String>,
    pub detached: bool,
    pub branches: Vec<BranchRef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRef {
    pub name: String,
    pub full_name: String,
    pub oid: String,
    pub kind: BranchKind,
    pub is_current: bool,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub is_favorite: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BranchKind {
    Local,
    Remote,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BranchError {
    InvalidName,
    AlreadyExists,
    LocalNotFound,
    NotFound,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
    StorageUnavailable,
}

pub async fn validate_branch_name_with_git(
    repository_path: &Path,
    name: &str,
    git: &dyn BranchGitPort,
) -> Result<(), BranchError> {
    if !is_branch_name_syntactically_valid(name) {
        return Err(BranchError::InvalidName);
    }
    match git
        .validate_name(repository_path, name)
        .await
        .map_err(map_git_error)?
    {
        true => Ok(()),
        false => Err(BranchError::InvalidName),
    }
}

pub async fn require_local_branch_with_git(
    repository_path: &Path,
    name: &str,
    git: &dyn BranchGitPort,
) -> Result<(), BranchError> {
    validate_branch_name_with_git(repository_path, name, git).await?;
    let references = git
        .list_references(repository_path)
        .await
        .map_err(map_git_error)?;
    if references
        .iter()
        .any(|branch| branch.full_name == format!("refs/heads/{name}"))
    {
        Ok(())
    } else {
        Err(BranchError::LocalNotFound)
    }
}

pub async fn ensure_local_branch_name_available_with_git(
    repository_path: &Path,
    name: &str,
    git: &dyn BranchGitPort,
) -> Result<(), BranchError> {
    let references = git
        .list_references(repository_path)
        .await
        .map_err(map_git_error)?;
    if references
        .iter()
        .any(|branch| branch.full_name == format!("refs/heads/{name}"))
    {
        Err(BranchError::AlreadyExists)
    } else {
        Ok(())
    }
}

pub async fn unmerged_commit_count_with_git(
    repository_path: &Path,
    current: &str,
    branch: &str,
    git: &dyn BranchGitPort,
) -> Result<u32, BranchError> {
    git.unmerged_commit_count(repository_path, current, branch)
        .await
        .map_err(map_git_error)
}

pub async fn paths_changed_between_with_git(
    repository_path: &Path,
    current: &str,
    target: &str,
    git: &dyn BranchGitPort,
) -> Result<Vec<String>, BranchError> {
    git.paths_changed_between(repository_path, current, target)
        .await
        .map_err(map_git_error)
}

pub async fn overlapping_dirty_paths_with_git(
    repository_path: &Path,
    current_head: Option<&str>,
    target: &str,
    dirty_paths: &[String],
    git: &dyn BranchGitPort,
) -> Result<Vec<String>, BranchError> {
    if dirty_paths.is_empty() {
        return Ok(Vec::new());
    }
    let Some(current_head) = current_head else {
        return Ok(Vec::new());
    };
    let changed_paths =
        paths_changed_between_with_git(repository_path, current_head, target, git).await?;
    Ok(dirty_paths
        .iter()
        .filter(|path| changed_paths.contains(path))
        .cloned()
        .collect())
}

pub async fn read_branches_with_git(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
    git: &dyn BranchGitPort,
) -> Result<BranchSnapshot, BranchError> {
    let references = git
        .list_references(repository_path)
        .await
        .map_err(map_git_error)?;
    let branches = references
        .into_iter()
        .map(|branch| map_branch_reference(branch, current))
        .collect();
    Ok(BranchSnapshot {
        repo_id,
        current: current.map(str::to_owned),
        detached,
        branches,
    })
}

pub async fn read_branches_with_favorites(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
    git: &dyn BranchGitPort,
    favorites_store: Arc<dyn BranchFavoriteStorePort>,
) -> Result<BranchSnapshot, BranchError> {
    let mut snapshot =
        read_branches_with_git(repo_id, repository_path, current, detached, git).await?;
    let favorite_repo_id = snapshot.repo_id.clone();
    let favorites = tokio::task::spawn_blocking(move || {
        favorites_store.list_branch_favorites(&favorite_repo_id)
    })
    .await
    .map_err(|_| BranchError::StorageUnavailable)?
    .map_err(|_| BranchError::StorageUnavailable)?;
    for branch in &mut snapshot.branches {
        branch.is_favorite = favorites
            .iter()
            .any(|full_name| full_name == &branch.full_name);
    }
    Ok(snapshot)
}

pub async fn set_branch_favorite_with_git(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
    full_name: &str,
    favorite: bool,
    git: &dyn BranchGitPort,
    favorites_store: Arc<dyn BranchFavoriteStorePort>,
) -> Result<BranchSnapshot, BranchError> {
    let mut snapshot = read_branches_with_favorites(
        repo_id.clone(),
        repository_path,
        current,
        detached,
        git,
        favorites_store.clone(),
    )
    .await?;
    let Some(branch) = snapshot
        .branches
        .iter_mut()
        .find(|branch| branch.full_name == full_name)
    else {
        return Err(BranchError::NotFound);
    };
    let storage_full_name = full_name.to_owned();
    tokio::task::spawn_blocking(move || {
        favorites_store.set_branch_favorite(&repo_id, &storage_full_name, favorite)
    })
    .await
    .map_err(|_| BranchError::StorageUnavailable)?
    .map_err(|_| BranchError::StorageUnavailable)?;
    branch.is_favorite = favorite;
    Ok(snapshot)
}

fn map_branch_reference(branch: BranchReference, current: Option<&str>) -> BranchRef {
    let kind = if branch.full_name.starts_with("refs/heads/") {
        BranchKind::Local
    } else {
        BranchKind::Remote
    };
    let is_current = matches!(kind, BranchKind::Local) && current == Some(branch.name.as_str());
    BranchRef {
        name: branch.name,
        full_name: branch.full_name,
        oid: branch.oid,
        kind,
        is_current,
        upstream: branch.upstream,
        upstream_gone: branch.upstream_gone,
        ahead: branch.ahead,
        behind: branch.behind,
        is_favorite: false,
    }
}

fn map_git_error(error: GitAdapterError) -> BranchError {
    match error {
        GitAdapterError::Unavailable => BranchError::GitUnavailable,
        GitAdapterError::TimedOut => BranchError::TimedOut,
        GitAdapterError::OutputTooLarge => BranchError::TooLarge,
        GitAdapterError::Failed | GitAdapterError::ReferenceAlreadyExists => BranchError::GitFailed,
    }
}

#[cfg(test)]
pub async fn read_branches(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
) -> Result<BranchSnapshot, BranchError> {
    read_branches_with_git(
        repo_id,
        repository_path,
        current,
        detached,
        &GitBranchAdapter,
    )
    .await
}

#[cfg(test)]
fn parse_track(value: &str) -> Result<(Option<u32>, Option<u32>, bool), BranchError> {
    crate::git::refs::parse_branch_track(value).map_err(map_git_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, process::Command as StdCommand};

    struct BranchFavorites(Vec<String>);

    impl BranchFavoriteStorePort for BranchFavorites {
        fn list_branch_favorites(
            &self,
            _repo_id: &str,
        ) -> Result<Vec<String>, crate::domain::error::RepositoryError> {
            Ok(self.0.clone())
        }

        fn set_branch_favorite(
            &self,
            _repo_id: &str,
            _full_name: &str,
            _favorite: bool,
        ) -> Result<(), crate::domain::error::RepositoryError> {
            Ok(())
        }

        fn rename_branch_favorite(
            &self,
            _repo_id: &str,
            _old_full_name: &str,
            _new_full_name: &str,
        ) -> Result<(), crate::domain::error::RepositoryError> {
            Ok(())
        }

        fn remove_branch_favorite(
            &self,
            _repo_id: &str,
            _full_name: &str,
        ) -> Result<(), crate::domain::error::RepositoryError> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct RecordingBranchFavorites(std::sync::Mutex<Vec<String>>);

    impl BranchFavoriteStorePort for RecordingBranchFavorites {
        fn list_branch_favorites(
            &self,
            _repo_id: &str,
        ) -> Result<Vec<String>, crate::domain::error::RepositoryError> {
            Ok(self.0.lock().unwrap().clone())
        }

        fn set_branch_favorite(
            &self,
            _repo_id: &str,
            full_name: &str,
            favorite: bool,
        ) -> Result<(), crate::domain::error::RepositoryError> {
            let mut favorites = self.0.lock().unwrap();
            if favorite && !favorites.iter().any(|value| value == full_name) {
                favorites.push(full_name.to_owned());
            } else if !favorite {
                favorites.retain(|value| value != full_name);
            }
            Ok(())
        }

        fn rename_branch_favorite(
            &self,
            _repo_id: &str,
            _old_full_name: &str,
            _new_full_name: &str,
        ) -> Result<(), crate::domain::error::RepositoryError> {
            Ok(())
        }

        fn remove_branch_favorite(
            &self,
            _repo_id: &str,
            _full_name: &str,
        ) -> Result<(), crate::domain::error::RepositoryError> {
            Ok(())
        }
    }

    fn git(path: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
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
    async fn reads_local_remote_upstream_and_ahead_behind_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("repo");
        std::fs::create_dir(&path).unwrap();
        git(&path, &["init", "--quiet"]);
        git(&path, &["config", "user.name", "Branch Test"]);
        git(&path, &["config", "user.email", "branch@example.invalid"]);
        std::fs::write(path.join("file.txt"), "base\n").unwrap();
        git(&path, &["add", "file.txt"]);
        git(&path, &["commit", "--quiet", "-m", "base"]);
        let default = git(&path, &["branch", "--show-current"]);
        let bare = directory.path().join("origin.git");
        git(
            directory.path(),
            &["init", "--bare", "--quiet", bare.to_str().unwrap()],
        );
        git(&path, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&path, &["push", "--quiet", "-u", "origin", &default]);
        git(&path, &["checkout", "--quiet", "-b", "feature/one"]);
        git(&path, &["push", "--quiet", "-u", "origin", "feature/one"]);
        std::fs::write(path.join("file.txt"), "ahead\n").unwrap();
        git(&path, &["commit", "--quiet", "-am", "ahead"]);

        let snapshot = read_branches("repo_fixture".into(), &path, Some("feature/one"), false)
            .await
            .unwrap();
        assert_eq!(snapshot.current.as_deref(), Some("feature/one"));
        let current = snapshot
            .branches
            .iter()
            .find(|branch| branch.is_current)
            .unwrap();
        assert_eq!(current.upstream.as_deref(), Some("origin/feature/one"));
        assert_eq!(current.ahead, Some(1));
        assert_eq!(current.behind, Some(0));
        let current_head = git(&path, &["rev-parse", "HEAD"]);
        let overlaps = overlapping_dirty_paths_with_git(
            &path,
            Some(&current_head),
            &default,
            &["file.txt".to_owned(), "unrelated.txt".to_owned()],
            &GitBranchAdapter,
        )
        .await
        .unwrap();
        assert_eq!(overlaps, vec!["file.txt"]);
        assert!(overlapping_dirty_paths_with_git(
            &path,
            None,
            &default,
            &["file.txt".to_owned()],
            &GitBranchAdapter,
        )
        .await
        .unwrap()
        .is_empty());
        assert!(snapshot
            .branches
            .iter()
            .any(|branch| matches!(branch.kind, BranchKind::Remote)));
        assert!(snapshot
            .branches
            .iter()
            .any(|branch| branch.name == default && !branch.is_current));
        require_local_branch_with_git(&path, "feature/one", &GitBranchAdapter)
            .await
            .unwrap();
        ensure_local_branch_name_available_with_git(&path, "new-branch", &GitBranchAdapter)
            .await
            .unwrap();
        assert!(matches!(
            ensure_local_branch_name_available_with_git(&path, &default, &GitBranchAdapter).await,
            Err(BranchError::AlreadyExists)
        ));
        assert!(matches!(
            require_local_branch_with_git(&path, "missing", &GitBranchAdapter).await,
            Err(BranchError::LocalNotFound)
        ));
    }

    #[tokio::test]
    async fn includes_saved_favorites_in_branch_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "--quiet"]);
        git(path, &["config", "user.name", "Branch Test"]);
        git(path, &["config", "user.email", "branch@example.invalid"]);
        std::fs::write(path.join("file.txt"), "base\n").unwrap();
        git(path, &["add", "file.txt"]);
        git(path, &["commit", "--quiet", "-m", "base"]);
        let current = git(path, &["branch", "--show-current"]);

        let snapshot = read_branches_with_favorites(
            "repo_fixture".into(),
            path,
            Some(&current),
            false,
            &GitBranchAdapter,
            Arc::new(BranchFavorites(vec![format!("refs/heads/{current}")])),
        )
        .await
        .unwrap();

        assert!(snapshot
            .branches
            .iter()
            .find(|branch| branch.name == current)
            .is_some_and(|branch| branch.is_favorite));
    }

    #[tokio::test]
    async fn sets_branch_favorite_in_service_and_returns_updated_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "--quiet"]);
        git(path, &["config", "user.name", "Branch Test"]);
        git(path, &["config", "user.email", "branch@example.invalid"]);
        std::fs::write(path.join("file.txt"), "base\n").unwrap();
        git(path, &["add", "file.txt"]);
        git(path, &["commit", "--quiet", "-m", "base"]);
        let current = git(path, &["branch", "--show-current"]);
        let full_name = format!("refs/heads/{current}");
        let store = Arc::new(RecordingBranchFavorites::default());

        let snapshot = set_branch_favorite_with_git(
            "repo_fixture".into(),
            path,
            Some(&current),
            false,
            &full_name,
            true,
            &GitBranchAdapter,
            store.clone(),
        )
        .await
        .unwrap();

        assert!(snapshot
            .branches
            .iter()
            .find(|branch| branch.full_name == full_name)
            .is_some_and(|branch| branch.is_favorite));
        assert_eq!(store.0.lock().unwrap().as_slice(), &[full_name]);
    }

    #[tokio::test]
    async fn setting_favorite_for_unknown_branch_returns_not_found() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "--quiet"]);

        let result = set_branch_favorite_with_git(
            "repo_fixture".into(),
            path,
            None,
            true,
            "refs/heads/missing",
            true,
            &GitBranchAdapter,
            Arc::new(RecordingBranchFavorites::default()),
        )
        .await;

        assert!(matches!(result, Err(BranchError::NotFound)));
    }

    #[test]
    fn parses_tracking_state_without_assuming_upstream_counts_exist() {
        assert_eq!(
            parse_track("[ahead 2, behind 3]"),
            Ok((Some(2), Some(3), false))
        );
        assert_eq!(parse_track("[ahead 1]"), Ok((Some(1), Some(0), false)));
        assert_eq!(parse_track("[behind 4]"), Ok((Some(0), Some(4), false)));
        assert_eq!(parse_track("[gone]"), Ok((None, None, true)));
        assert_eq!(parse_track(""), Ok((None, None, false)));
    }
}
