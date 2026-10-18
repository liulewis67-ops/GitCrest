use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BranchDeletePreviewData {
    pub is_current: bool,
    pub unmerged_commit_count: u32,
    pub requires_confirmation: bool,
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
    /// Folder of another working tree that has this branch checked out (never the current one).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
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
    NameUnchanged,
    AlreadyExists,
    LocalNotFound,
    NotFound,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
    StorageUnavailable,
    RequiresCommit,
    Current,
    Unmerged(u32),
    AlreadyCurrent,
    WorktreeDirty,
}

pub struct SetFavoriteCommand {
    pub repo_id: String,
    pub repository_path: PathBuf,
    pub current_branch: Option<String>,
    pub detached: bool,
    pub full_name: String,
    pub favorite: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchFavoriteMutation {
    Rename {
        old_full_name: String,
        new_full_name: String,
    },
    Remove {
        full_name: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum BranchTaskFailure<E> {
    Command(E),
    StorageUnavailable,
}

pub async fn execute_branch_and_update_favorites<E, F, Fut>(
    repo_id: String,
    mutation: BranchFavoriteMutation,
    favorites_store: Arc<dyn BranchFavoriteStorePort>,
    execute_command: F,
) -> Result<(), BranchTaskFailure<E>>
where
    E: Send,
    F: FnOnce() -> Fut + Send,
    Fut: Future<Output = Result<(), E>> + Send,
{
    execute_command()
        .await
        .map_err(BranchTaskFailure::Command)?;
    tokio::task::spawn_blocking(move || match mutation {
        BranchFavoriteMutation::Rename {
            old_full_name,
            new_full_name,
        } => favorites_store.rename_branch_favorite(&repo_id, &old_full_name, &new_full_name),
        BranchFavoriteMutation::Remove { full_name } => {
            favorites_store.remove_branch_favorite(&repo_id, &full_name)
        }
    })
    .await
    .map_err(|_| BranchTaskFailure::StorageUnavailable)?
    .map_err(|_| BranchTaskFailure::StorageUnavailable)
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

pub async fn validate_branch_rename_with_git(
    repository_path: &Path,
    old_name: &str,
    new_name: &str,
    git: &dyn BranchGitPort,
) -> Result<(), BranchError> {
    validate_branch_name_with_git(repository_path, new_name, git).await?;
    if old_name == new_name {
        return Err(BranchError::NameUnchanged);
    }
    ensure_local_branch_name_available_with_git(repository_path, new_name, git).await
}

pub async fn ensure_branch_creation_allowed_with_git(
    repository_path: &Path,
    name: &str,
    initial_commit_exists: bool,
    git: &dyn BranchGitPort,
) -> Result<(), BranchError> {
    if !initial_commit_exists {
        return Err(BranchError::RequiresCommit);
    }
    ensure_local_branch_name_available_with_git(repository_path, name, git).await
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

pub async fn preview_branch_delete_with_git(
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
    target: &str,
    git: &dyn BranchGitPort,
) -> Result<BranchDeletePreviewData, BranchError> {
    let is_current = current == Some(target);
    let unmerged_commit_count = match current {
        Some(current) if !detached && !is_current => {
            unmerged_commit_count_with_git(repository_path, current, target, git).await?
        }
        _ => 0,
    };
    Ok(BranchDeletePreviewData {
        is_current,
        unmerged_commit_count,
        requires_confirmation: unmerged_commit_count > 0,
    })
}

pub async fn validate_branch_delete_with_git(
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
    target: &str,
    allow_unmerged: bool,
    git: &dyn BranchGitPort,
) -> Result<BranchDeletePreviewData, BranchError> {
    let preview =
        preview_branch_delete_with_git(repository_path, current, detached, target, git).await?;
    if preview.is_current {
        return Err(BranchError::Current);
    }
    if preview.unmerged_commit_count > 0 && !allow_unmerged {
        return Err(BranchError::Unmerged(preview.unmerged_commit_count));
    }
    Ok(preview)
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

pub fn ensure_branch_not_current(current: Option<&str>, target: &str) -> Result<(), BranchError> {
    if current == Some(target) {
        Err(BranchError::AlreadyCurrent)
    } else {
        Ok(())
    }
}

pub async fn ensure_no_dirty_path_overlap_with_git(
    repository_path: &Path,
    current_head: Option<&str>,
    target: &str,
    dirty_paths: &[String],
    git: &dyn BranchGitPort,
) -> Result<(), BranchError> {
    if overlapping_dirty_paths_with_git(repository_path, current_head, target, dirty_paths, git)
        .await?
        .is_empty()
    {
        Ok(())
    } else {
        Err(BranchError::WorktreeDirty)
    }
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
    command: SetFavoriteCommand,
    git: &dyn BranchGitPort,
    favorites_store: Arc<dyn BranchFavoriteStorePort>,
) -> Result<BranchSnapshot, BranchError> {
    let mut snapshot = read_branches_with_favorites(
        command.repo_id.clone(),
        &command.repository_path,
        command.current_branch.as_deref(),
        command.detached,
        git,
        favorites_store.clone(),
    )
    .await?;
    let Some(branch) = snapshot
        .branches
        .iter_mut()
        .find(|branch| branch.full_name == command.full_name)
    else {
        return Err(BranchError::NotFound);
    };
    let storage_full_name = command.full_name;
    let repo_id = command.repo_id;
    let favorite = command.favorite;
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
        worktree_path: if is_current {
            None
        } else {
            branch.worktree_path
        },
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
            old_full_name: &str,
            new_full_name: &str,
        ) -> Result<(), crate::domain::error::RepositoryError> {
            let mut favorites = self.0.lock().unwrap();
            if let Some(favorite) = favorites
                .iter_mut()
                .find(|value| value.as_str() == old_full_name)
            {
                *favorite = new_full_name.to_owned();
            }
            Ok(())
        }

        fn remove_branch_favorite(
            &self,
            _repo_id: &str,
            full_name: &str,
        ) -> Result<(), crate::domain::error::RepositoryError> {
            self.0
                .lock()
                .unwrap()
                .retain(|favorite| favorite != full_name);
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
        assert!(matches!(
            ensure_no_dirty_path_overlap_with_git(
                &path,
                Some(&current_head),
                &default,
                &["file.txt".to_owned()],
                &GitBranchAdapter,
            )
            .await,
            Err(BranchError::WorktreeDirty)
        ));
        ensure_no_dirty_path_overlap_with_git(
            &path,
            Some(&current_head),
            &default,
            &["unrelated.txt".to_owned()],
            &GitBranchAdapter,
        )
        .await
        .unwrap();
        assert!(matches!(
            ensure_branch_not_current(Some("feature/one"), "feature/one"),
            Err(BranchError::AlreadyCurrent)
        ));
        ensure_branch_not_current(Some("main"), "feature/one").unwrap();
        let delete_preview = preview_branch_delete_with_git(
            &path,
            Some(&default),
            false,
            "feature/one",
            &GitBranchAdapter,
        )
        .await
        .unwrap();
        assert_eq!(delete_preview.unmerged_commit_count, 1);
        assert!(delete_preview.requires_confirmation);
        let current_delete_preview = preview_branch_delete_with_git(
            &path,
            Some(&default),
            false,
            &default,
            &GitBranchAdapter,
        )
        .await
        .unwrap();
        assert!(current_delete_preview.is_current);
        assert_eq!(current_delete_preview.unmerged_commit_count, 0);
        assert!(matches!(
            validate_branch_delete_with_git(
                &path,
                Some(&default),
                false,
                "feature/one",
                false,
                &GitBranchAdapter
            )
            .await,
            Err(BranchError::Unmerged(1))
        ));
        assert!(matches!(
            validate_branch_delete_with_git(
                &path,
                Some(&default),
                false,
                &default,
                true,
                &GitBranchAdapter
            )
            .await,
            Err(BranchError::Current)
        ));
        assert!(validate_branch_delete_with_git(
            &path,
            Some(&default),
            false,
            "feature/one",
            true,
            &GitBranchAdapter,
        )
        .await
        .is_ok());
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
        validate_branch_rename_with_git(&path, "feature/one", "new-branch", &GitBranchAdapter)
            .await
            .unwrap();
        ensure_branch_creation_allowed_with_git(&path, "created-branch", true, &GitBranchAdapter)
            .await
            .unwrap();
        assert!(matches!(
            ensure_branch_creation_allowed_with_git(&path, &default, false, &GitBranchAdapter)
                .await,
            Err(BranchError::RequiresCommit)
        ));
        assert!(matches!(
            ensure_branch_creation_allowed_with_git(&path, &default, true, &GitBranchAdapter).await,
            Err(BranchError::AlreadyExists)
        ));
        assert!(matches!(
            validate_branch_rename_with_git(&path, "feature/one", "feature/one", &GitBranchAdapter)
                .await,
            Err(BranchError::NameUnchanged)
        ));
        assert!(matches!(
            validate_branch_rename_with_git(&path, "feature/one", &default, &GitBranchAdapter)
                .await,
            Err(BranchError::AlreadyExists)
        ));
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
            SetFavoriteCommand {
                repo_id: "repo_fixture".into(),
                repository_path: path.to_owned(),
                current_branch: Some(current.clone()),
                detached: false,
                full_name: full_name.clone(),
                favorite: true,
            },
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
            SetFavoriteCommand {
                repo_id: "repo_fixture".into(),
                repository_path: path.to_owned(),
                current_branch: None,
                detached: true,
                full_name: "refs/heads/missing".into(),
                favorite: true,
            },
            &GitBranchAdapter,
            Arc::new(RecordingBranchFavorites::default()),
        )
        .await;

        assert!(matches!(result, Err(BranchError::NotFound)));
    }

    #[tokio::test]
    async fn updates_favorites_only_after_branch_command_succeeds() {
        let old_full_name = "refs/heads/feature/one".to_owned();
        let new_full_name = "refs/heads/feature/two".to_owned();
        let store = Arc::new(RecordingBranchFavorites(std::sync::Mutex::new(vec![
            old_full_name.clone(),
        ])));

        let failed = execute_branch_and_update_favorites(
            "repo_fixture".into(),
            BranchFavoriteMutation::Rename {
                old_full_name: old_full_name.clone(),
                new_full_name: new_full_name.clone(),
            },
            store.clone(),
            || async { Err("git failed") },
        )
        .await;

        assert_eq!(failed, Err(BranchTaskFailure::Command("git failed")));
        assert_eq!(store.0.lock().unwrap().as_slice(), &[old_full_name]);

        execute_branch_and_update_favorites(
            "repo_fixture".into(),
            BranchFavoriteMutation::Rename {
                old_full_name: "refs/heads/feature/one".into(),
                new_full_name: new_full_name.clone(),
            },
            store.clone(),
            || async { Ok::<(), &str>(()) },
        )
        .await
        .unwrap();
        assert_eq!(
            store.0.lock().unwrap().as_slice(),
            std::slice::from_ref(&new_full_name)
        );

        execute_branch_and_update_favorites(
            "repo_fixture".into(),
            BranchFavoriteMutation::Remove {
                full_name: new_full_name,
            },
            store.clone(),
            || async { Ok::<(), &str>(()) },
        )
        .await
        .unwrap();
        assert!(store.0.lock().unwrap().is_empty());
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
