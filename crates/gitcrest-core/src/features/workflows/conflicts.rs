use std::path::{Component, Path};

use crate::{
    domain::{error::ConflictError, workflow::WorkflowOperation},
    ports::conflicts::{ConflictGitPort, ConflictWorktreePort},
};
use sha2::{Digest, Sha256};

const MAX_CONFLICT_FILE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictFile {
    pub repo_id: String,
    pub task_id: String,
    pub path: String,
    pub operation: WorkflowOperation,
    pub head_oid: Option<String>,
    pub base_content: Option<String>,
    pub ours_content: Option<String>,
    pub theirs_content: Option<String>,
    pub result_content: Option<String>,
    pub result_revision: String,
    pub is_text: bool,
    /// Whether the current-branch (ours) side still has the file.
    pub ours_present: bool,
    /// Whether the incoming (theirs) side still has the file.
    pub theirs_present: bool,
}

pub struct ReadConflictCommand {
    pub repo_id: String,
    pub task_id: String,
    pub operation: WorkflowOperation,
    pub head_oid: Option<String>,
    pub relative_path: String,
}

pub async fn read_file(
    git: &impl ConflictGitPort,
    worktree: &(impl ConflictWorktreePort + ?Sized),
    repository_path: &Path,
    command: ReadConflictCommand,
) -> Result<ConflictFile, ConflictError> {
    let ReadConflictCommand {
        repo_id,
        task_id,
        operation,
        head_oid,
        relative_path,
    } = command;
    let relative_path = relative_path.as_str();
    validate_relative_path(relative_path)?;
    let index_stages = git
        .read_conflict_stages(repository_path, relative_path)
        .await?;
    if index_stages.is_empty() {
        return Err(ConflictError::NotConflicted);
    }
    let base = read_stage(git, repository_path, index_stages.get(&1)).await?;
    let ours = read_stage(git, repository_path, index_stages.get(&2)).await?;
    let theirs = read_stage(git, repository_path, index_stages.get(&3)).await?;
    let result = worktree
        .read_conflict_worktree_file(repository_path, relative_path)
        .await?;
    let is_text = [&base, &ours, &theirs, &result]
        .into_iter()
        .flatten()
        .all(|bytes| std::str::from_utf8(bytes).is_ok() && !bytes.contains(&0));
    let result_revision = revision(&result);
    let to_text = |value: Option<Vec<u8>>| value.and_then(|bytes| String::from_utf8(bytes).ok());
    Ok(ConflictFile {
        repo_id,
        task_id,
        path: relative_path.to_owned(),
        operation,
        head_oid,
        base_content: to_text(base),
        ours_content: to_text(ours),
        theirs_content: to_text(theirs),
        result_content: to_text(result),
        result_revision,
        is_text,
        ours_present: index_stages.contains_key(&2),
        theirs_present: index_stages.contains_key(&3),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictSide {
    Ours,
    Theirs,
}

/// Resolves a conflicted file by taking one whole side (or its deletion). Works for binary
/// files, where the text merge editor cannot be used.
pub async fn choose_side(
    git: &impl ConflictGitPort,
    worktree: &(impl ConflictWorktreePort + ?Sized),
    repository_path: &Path,
    relative_path: &str,
    side: ConflictSide,
    expected_revision: &str,
) -> Result<(), ConflictError> {
    validate_relative_path(relative_path)?;
    let stages = git
        .read_conflict_stages(repository_path, relative_path)
        .await?;
    if stages.is_empty() {
        return Err(ConflictError::NotConflicted);
    }
    let current = worktree
        .read_conflict_worktree_file(repository_path, relative_path)
        .await?;
    if revision(&current) != expected_revision {
        return Err(ConflictError::StaleRevision);
    }
    let stage = if side == ConflictSide::Ours { 2 } else { 3 };
    git.resolve_conflict_side(
        repository_path,
        relative_path,
        stage,
        stages.contains_key(&stage),
    )
    .await?;
    if !git
        .read_conflict_stages(repository_path, relative_path)
        .await?
        .is_empty()
    {
        return Err(ConflictError::GitFailed);
    }
    Ok(())
}

pub async fn save_result(
    git: &impl ConflictGitPort,
    worktree: &(impl ConflictWorktreePort + ?Sized),
    repository_path: &Path,
    relative_path: &str,
    expected_revision: &str,
    content: &str,
) -> Result<String, ConflictError> {
    validate_relative_path(relative_path)?;
    validate_content(content)?;
    if git
        .read_conflict_stages(repository_path, relative_path)
        .await?
        .is_empty()
    {
        return Err(ConflictError::NotConflicted);
    }
    let current = worktree
        .read_conflict_worktree_file(repository_path, relative_path)
        .await?;
    if revision(&current) != expected_revision {
        return Err(ConflictError::StaleRevision);
    }
    worktree
        .write_conflict_worktree_file(repository_path, relative_path, content.as_bytes())
        .await?;
    Ok(revision(&Some(content.as_bytes().to_vec())))
}

pub async fn mark_resolved(
    git: &impl ConflictGitPort,
    worktree: &(impl ConflictWorktreePort + ?Sized),
    repository_path: &Path,
    relative_path: &str,
    expected_revision: &str,
) -> Result<(), ConflictError> {
    validate_relative_path(relative_path)?;
    if git
        .read_conflict_stages(repository_path, relative_path)
        .await?
        .is_empty()
    {
        return Err(ConflictError::NotConflicted);
    }
    let current = worktree
        .read_conflict_worktree_file(repository_path, relative_path)
        .await?;
    let Some(content) = current.as_deref() else {
        return Err(ConflictError::FileNotFound);
    };
    if revision(&current) != expected_revision {
        return Err(ConflictError::StaleRevision);
    }
    let text = std::str::from_utf8(content).map_err(|_| ConflictError::Binary)?;
    if !is_text_without_conflict_markers(text) {
        return Err(ConflictError::UnresolvedMarkers);
    }
    git.stage_conflict_file(repository_path, relative_path)
        .await?;
    if !git
        .read_conflict_stages(repository_path, relative_path)
        .await?
        .is_empty()
    {
        return Err(ConflictError::GitFailed);
    }
    Ok(())
}

pub fn is_text_without_conflict_markers(value: &str) -> bool {
    !value.lines().any(|line| {
        let line = line.trim_start();
        ["<<<<<<<", "|||||||", "=======", ">>>>>>>"]
            .iter()
            .any(|marker| line.starts_with(marker))
    })
}

fn validate_content(content: &str) -> Result<(), ConflictError> {
    if content.len() > MAX_CONFLICT_FILE_BYTES {
        return Err(ConflictError::TooLarge);
    }
    if content.contains('\0') {
        return Err(ConflictError::Binary);
    }
    Ok(())
}

pub fn validate_relative_path(value: &str) -> Result<(), ConflictError> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || Path::new(value).is_absolute()
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(ConflictError::InvalidPath);
    }
    Ok(())
}

fn revision(value: &Option<Vec<u8>>) -> String {
    let mut digest = Sha256::new();
    match value {
        Some(bytes) => {
            digest.update([1]);
            digest.update(bytes);
        }
        None => digest.update([0]),
    }
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn read_stage(
    git: &impl ConflictGitPort,
    repository_path: &Path,
    oid: Option<&String>,
) -> Result<Option<Vec<u8>>, ConflictError> {
    let Some(oid) = oid else { return Ok(None) };
    let bytes = git.read_conflict_blob(repository_path, oid).await?;
    if bytes.len() > MAX_CONFLICT_FILE_BYTES {
        return Err(ConflictError::TooLarge);
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use tempfile::TempDir;

    use crate::git::command::GitCommandService;
    use crate::storage::conflicts::ConflictWorktreeAdapter;

    use super::*;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
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

    fn conflicting_repo() -> TempDir {
        let directory = tempfile::tempdir().unwrap();
        git(directory.path(), &["init", "--quiet"]);
        git(directory.path(), &["config", "user.name", "Fixture"]);
        git(
            directory.path(),
            &["config", "user.email", "fixture@example.test"],
        );
        fs::write(directory.path().join("file.txt"), "base\n").unwrap();
        git(directory.path(), &["add", "file.txt"]);
        git(directory.path(), &["commit", "--quiet", "-m", "base"]);
        let base = git(directory.path(), &["rev-parse", "HEAD"]);
        git(directory.path(), &["checkout", "--quiet", "-b", "theirs"]);
        fs::write(directory.path().join("file.txt"), "theirs\n").unwrap();
        git(directory.path(), &["commit", "--quiet", "-am", "theirs"]);
        git(
            directory.path(),
            &["checkout", "--quiet", "-b", "ours", &base],
        );
        fs::write(directory.path().join("file.txt"), "ours\n").unwrap();
        git(directory.path(), &["commit", "--quiet", "-am", "ours"]);
        let merge = Command::new("git")
            .arg("-C")
            .arg(directory.path())
            .args(["merge", "theirs"])
            .output()
            .unwrap();
        assert!(!merge.status.success());
        directory
    }

    #[tokio::test]
    async fn reads_three_stages_and_the_persisted_working_result() {
        let repository = conflicting_repo();
        let git_service = GitCommandService::default();
        let worktree = ConflictWorktreeAdapter;
        let result = read_file(
            &git_service,
            &worktree,
            repository.path(),
            ReadConflictCommand {
                repo_id: "repo_fixture".into(),
                task_id: "task_fixture".into(),
                operation: WorkflowOperation::Merge,
                head_oid: Some(git(repository.path(), &["rev-parse", "HEAD"])),
                relative_path: "file.txt".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(result.base_content.as_deref(), Some("base\n"));
        assert_eq!(result.ours_content.as_deref(), Some("ours\n"));
        assert_eq!(result.theirs_content.as_deref(), Some("theirs\n"));
        assert!(result
            .result_content
            .as_deref()
            .unwrap()
            .contains("<<<<<<<"));
        assert!(result.is_text);
        assert_eq!(result.result_revision.len(), 64);
    }

    #[tokio::test]
    async fn saves_only_the_current_conflict_and_refuses_stale_or_unresolved_results() {
        let repository = conflicting_repo();
        let git_service = GitCommandService::default();
        let worktree = ConflictWorktreeAdapter;
        let snapshot = read_file(
            &git_service,
            &worktree,
            repository.path(),
            ReadConflictCommand {
                repo_id: "repo_fixture".into(),
                task_id: "task_fixture".into(),
                operation: WorkflowOperation::Merge,
                head_oid: Some(git(repository.path(), &["rev-parse", "HEAD"])),
                relative_path: "file.txt".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            save_result(
                &git_service,
                &worktree,
                repository.path(),
                "file.txt",
                "stale",
                "resolved\n"
            )
            .await,
            Err(ConflictError::StaleRevision)
        );
        let content = "resolved safely\n";
        let revision = save_result(
            &git_service,
            &worktree,
            repository.path(),
            "file.txt",
            &snapshot.result_revision,
            content,
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(repository.path().join("file.txt")).unwrap(),
            content
        );
        assert_eq!(
            mark_resolved(
                &git_service,
                &worktree,
                repository.path(),
                "file.txt",
                "stale"
            )
            .await,
            Err(ConflictError::StaleRevision)
        );
        let marked = save_result(
            &git_service,
            &worktree,
            repository.path(),
            "file.txt",
            &revision,
            "<<<<<<< ours\nnot resolved\n=======\n",
        )
        .await
        .unwrap();
        assert_eq!(
            mark_resolved(
                &git_service,
                &worktree,
                repository.path(),
                "file.txt",
                &marked
            )
            .await,
            Err(ConflictError::UnresolvedMarkers)
        );
        let current = save_result(
            &git_service,
            &worktree,
            repository.path(),
            "file.txt",
            &marked,
            content,
        )
        .await
        .unwrap();
        mark_resolved(
            &git_service,
            &worktree,
            repository.path(),
            "file.txt",
            &current,
        )
        .await
        .unwrap();
        assert!(git_service
            .read_conflict_stages(repository.path(), "file.txt")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            git(repository.path(), &["show", ":file.txt"]),
            "resolved safely"
        );
    }

    fn repo_with(setup: impl Fn(&Path)) -> TempDir {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        git(root, &["init", "--quiet", "--initial-branch=main"]);
        git(root, &["config", "user.name", "Fixture"]);
        git(root, &["config", "user.email", "fixture@example.test"]);
        setup(root);
        directory
    }

    async fn snapshot(repository: &Path, path: &str) -> ConflictFile {
        read_file(
            &GitCommandService::default(),
            &ConflictWorktreeAdapter,
            repository,
            ReadConflictCommand {
                repo_id: "repo_fixture".into(),
                task_id: "task_fixture".into(),
                operation: WorkflowOperation::Merge,
                head_oid: Some(git(repository, &["rev-parse", "HEAD"])),
                relative_path: path.into(),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn chooses_a_whole_side_for_a_binary_conflict() {
        let repository = repo_with(|root| {
            fs::write(root.join("image.bin"), [0u8, 1, 2, 3]).unwrap();
            git(root, &["add", "image.bin"]);
            git(root, &["commit", "--quiet", "-m", "base"]);
            git(root, &["checkout", "--quiet", "-b", "theirs"]);
            fs::write(root.join("image.bin"), [0u8, 9, 9, 9]).unwrap();
            git(root, &["commit", "--quiet", "-am", "theirs"]);
            git(root, &["checkout", "--quiet", "main"]);
            fs::write(root.join("image.bin"), [0u8, 5, 5, 5]).unwrap();
            git(root, &["commit", "--quiet", "-am", "ours"]);
            let merge = Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["merge", "theirs"])
                .output()
                .unwrap();
            assert!(!merge.status.success());
        });
        let file = snapshot(repository.path(), "image.bin").await;
        assert!(!file.is_text);
        assert!(file.ours_present && file.theirs_present);
        let git_service = GitCommandService::default();
        assert_eq!(
            choose_side(
                &git_service,
                &ConflictWorktreeAdapter,
                repository.path(),
                "image.bin",
                ConflictSide::Theirs,
                "stale"
            )
            .await,
            Err(ConflictError::StaleRevision)
        );
        choose_side(
            &git_service,
            &ConflictWorktreeAdapter,
            repository.path(),
            "image.bin",
            ConflictSide::Theirs,
            &file.result_revision,
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read(repository.path().join("image.bin")).unwrap(),
            vec![0u8, 9, 9, 9]
        );
        assert_eq!(git(repository.path(), &["ls-files", "-u"]), "");
    }

    #[tokio::test]
    async fn chooses_deletion_for_a_delete_modify_conflict() {
        let repository = repo_with(|root| {
            fs::write(root.join("gone.txt"), "base\n").unwrap();
            git(root, &["add", "gone.txt"]);
            git(root, &["commit", "--quiet", "-m", "base"]);
            git(root, &["checkout", "--quiet", "-b", "theirs"]);
            git(root, &["rm", "--quiet", "gone.txt"]);
            git(root, &["commit", "--quiet", "-m", "theirs deletes"]);
            git(root, &["checkout", "--quiet", "main"]);
            fs::write(root.join("gone.txt"), "ours edit\n").unwrap();
            git(root, &["commit", "--quiet", "-am", "ours edits"]);
            let merge = Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["merge", "theirs"])
                .output()
                .unwrap();
            assert!(!merge.status.success());
        });
        let file = snapshot(repository.path(), "gone.txt").await;
        assert!(file.ours_present);
        assert!(!file.theirs_present);
        choose_side(
            &GitCommandService::default(),
            &ConflictWorktreeAdapter,
            repository.path(),
            "gone.txt",
            ConflictSide::Theirs,
            &file.result_revision,
        )
        .await
        .unwrap();
        assert!(!repository.path().join("gone.txt").exists());
        assert_eq!(git(repository.path(), &["ls-files", "-u"]), "");
    }

    #[test]
    fn rejects_absolute_parent_and_empty_paths() {
        for path in ["", "../outside", "/absolute", "a/../outside"] {
            assert_eq!(
                validate_relative_path(path),
                Err(ConflictError::InvalidPath)
            );
        }
        assert_eq!(validate_relative_path("folder/file.txt"), Ok(()));
    }
}
