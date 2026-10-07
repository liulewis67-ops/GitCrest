use serde::{Deserialize, Serialize};
use std::{ffi::OsString, path::Component};

use crate::status::{ChangeCategory, ChangeKind, StatusFile, StatusSnapshot};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StagingAction {
    StageFile,
    UnstageFile,
    StageAll,
    UnstageAll,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagingRequest {
    pub action: StagingAction,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StagingError {
    InvalidRequest,
    FileNotChanged,
    FileNotStaged,
    ConflictMustBeResolvedFirst,
}

pub struct StagingCommand {
    pub arguments: Vec<OsString>,
    pub label: &'static str,
    pub log_label: &'static str,
}

pub fn command(
    snapshot: &StatusSnapshot,
    request: &StagingRequest,
) -> Result<StagingCommand, StagingError> {
    if matches!(
        request.action,
        StagingAction::StageAll | StagingAction::UnstageAll
    ) && request.path.is_some()
    {
        return Err(StagingError::InvalidRequest);
    }
    if matches!(
        request.action,
        StagingAction::StageAll | StagingAction::UnstageAll
    ) && snapshot
        .files
        .iter()
        .any(|file| file.categories.contains(&ChangeCategory::Conflicted))
    {
        return Err(StagingError::ConflictMustBeResolvedFirst);
    }
    match request.action {
        StagingAction::StageAll => Ok(simple_command(
            ["--literal-pathspecs", "add", "--all", "--", "."],
            "Stage all changes",
            "git add --all <repository>",
        )),
        StagingAction::UnstageAll => Ok(simple_command(
            ["reset", "--mixed"],
            "Unstage all changes",
            "git reset --mixed",
        )),
        StagingAction::StageFile | StagingAction::UnstageFile => {
            let path = request
                .path
                .as_deref()
                .ok_or(StagingError::InvalidRequest)?;
            validate_relative_path(path)?;
            let file = snapshot
                .files
                .iter()
                .find(|file| file.path == path)
                .ok_or(StagingError::FileNotChanged)?;
            if file.categories.contains(&ChangeCategory::Conflicted)
                || file.kind == ChangeKind::Conflicted
            {
                return Err(StagingError::ConflictMustBeResolvedFirst);
            }
            match request.action {
                StagingAction::StageFile => {
                    if file.categories.contains(&ChangeCategory::Ignored) {
                        return Err(StagingError::FileNotChanged);
                    }
                    Ok(path_command(
                        ["--literal-pathspecs", "add", "--"],
                        path,
                        "Stage file",
                        "git add <selected path>",
                    ))
                }
                StagingAction::UnstageFile => {
                    if !file.categories.contains(&ChangeCategory::Staged) {
                        return Err(StagingError::FileNotStaged);
                    }
                    unstage_file(file)
                }
                _ => unreachable!(),
            }
        }
    }
}

fn unstage_file(file: &StatusFile) -> Result<StagingCommand, StagingError> {
    if file.index_status == "A" || file.kind == ChangeKind::Added {
        return Ok(path_command(
            ["--literal-pathspecs", "rm", "--cached", "--force", "--"],
            &file.path,
            "Unstage added file",
            "git rm --cached <selected path>",
        ));
    }
    if file.kind == ChangeKind::Renamed {
        let original = file
            .original_path
            .as_deref()
            .ok_or(StagingError::InvalidRequest)?;
        validate_relative_path(original)?;
        let mut arguments = ["--literal-pathspecs", "restore", "--staged", "--"]
            .map(OsString::from)
            .to_vec();
        arguments.push(original.into());
        arguments.push(file.path.clone().into());
        return Ok(StagingCommand {
            arguments,
            label: "Unstage renamed file",
            log_label: "git restore --staged <selected paths>",
        });
    }
    Ok(path_command(
        ["--literal-pathspecs", "restore", "--staged", "--"],
        &file.path,
        "Unstage file",
        "git restore --staged <selected path>",
    ))
}

fn simple_command<const N: usize>(
    args: [&str; N],
    label: &'static str,
    log_label: &'static str,
) -> StagingCommand {
    StagingCommand {
        arguments: args.into_iter().map(OsString::from).collect(),
        label,
        log_label,
    }
}

fn path_command<const N: usize>(
    prefix: [&str; N],
    path: &str,
    label: &'static str,
    log_label: &'static str,
) -> StagingCommand {
    let mut arguments = prefix.into_iter().map(OsString::from).collect::<Vec<_>>();
    arguments.push(path.into());
    StagingCommand {
        arguments,
        label,
        log_label,
    }
}

fn validate_relative_path(path: &str) -> Result<(), StagingError> {
    if path.is_empty()
        || path.chars().any(char::is_control)
        || std::path::Path::new(path).is_absolute()
        || !std::path::Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(StagingError::InvalidRequest);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn git(root: &Path, arguments: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn run(root: &Path, command: StagingCommand) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(command.arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    async fn fixture() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet"]);
        git(&root, &["config", "user.name", "GitCrest Test"]);
        git(
            &root,
            &["config", "user.email", "gitcrest-test@example.invalid"],
        );
        std::fs::write(root.join("tracked.txt"), "base\n").unwrap();
        std::fs::write(root.join("deleted.txt"), "delete me\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "--quiet", "-m", "base"]);
        (directory, root)
    }

    fn request(action: StagingAction, path: Option<&str>) -> StagingRequest {
        StagingRequest {
            action,
            path: path.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn staging_and_unstaging_a_file_preserves_worktree_edits_and_added_files() {
        let (_directory, root) = fixture().await;
        std::fs::write(root.join("tracked.txt"), "staged version\n").unwrap();
        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        run(
            &root,
            command(
                &snapshot,
                &request(StagingAction::StageFile, Some("tracked.txt")),
            )
            .unwrap(),
        );
        std::fs::write(root.join("tracked.txt"), "working version\n").unwrap();
        std::fs::write(root.join("new file.txt"), "new\n").unwrap();
        std::fs::remove_file(root.join("deleted.txt")).unwrap();

        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        let tracked = snapshot
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .unwrap();
        assert!(tracked.categories.contains(&ChangeCategory::Staged));
        assert!(tracked.categories.contains(&ChangeCategory::Unstaged));
        run(
            &root,
            command(
                &snapshot,
                &request(StagingAction::UnstageFile, Some("tracked.txt")),
            )
            .unwrap(),
        );
        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        let tracked = snapshot
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .unwrap();
        assert!(!tracked.categories.contains(&ChangeCategory::Staged));
        assert!(tracked.categories.contains(&ChangeCategory::Unstaged));

        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        run(
            &root,
            command(
                &snapshot,
                &request(StagingAction::StageFile, Some("new file.txt")),
            )
            .unwrap(),
        );
        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        run(
            &root,
            command(
                &snapshot,
                &request(StagingAction::UnstageFile, Some("new file.txt")),
            )
            .unwrap(),
        );
        assert!(root.join("new file.txt").exists());
        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        let added = snapshot
            .files
            .iter()
            .find(|file| file.path == "new file.txt")
            .unwrap();
        assert!(added.categories.contains(&ChangeCategory::Untracked));
        assert!(!added.categories.contains(&ChangeCategory::Staged));

        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        run(
            &root,
            command(
                &snapshot,
                &request(StagingAction::StageFile, Some("deleted.txt")),
            )
            .unwrap(),
        );
        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        run(
            &root,
            command(
                &snapshot,
                &request(StagingAction::UnstageFile, Some("deleted.txt")),
            )
            .unwrap(),
        );
        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        let deleted = snapshot
            .files
            .iter()
            .find(|file| file.path == "deleted.txt")
            .unwrap();
        assert!(deleted.categories.contains(&ChangeCategory::Unstaged));
        assert!(!deleted.categories.contains(&ChangeCategory::Staged));
    }

    #[tokio::test]
    async fn stage_all_and_unstage_all_work_with_and_without_a_head() {
        let (_directory, root) = fixture().await;
        std::fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        run(
            &root,
            command(&snapshot, &request(StagingAction::StageAll, None)).unwrap(),
        );
        let staged = crate::status::read("repo".into(), &root).await.unwrap();
        assert!(staged
            .files
            .iter()
            .all(|file| file.categories.contains(&ChangeCategory::Staged)));
        run(
            &root,
            command(&staged, &request(StagingAction::UnstageAll, None)).unwrap(),
        );
        let unstaged = crate::status::read("repo".into(), &root).await.unwrap();
        assert!(unstaged
            .files
            .iter()
            .all(|file| !file.categories.contains(&ChangeCategory::Staged)));
        assert!(unstaged
            .files
            .iter()
            .any(|file| file.categories.contains(&ChangeCategory::Untracked)));

        let unborn_directory = tempfile::tempdir().unwrap();
        let unborn = unborn_directory.path().join("repo");
        std::fs::create_dir(&unborn).unwrap();
        git(&unborn, &["init", "--quiet"]);
        git(&unborn, &["config", "user.name", "GitCrest Test"]);
        git(
            &unborn,
            &["config", "user.email", "gitcrest-test@example.invalid"],
        );
        std::fs::write(unborn.join("new.txt"), "new\n").unwrap();
        let snapshot = crate::status::read("repo".into(), &unborn).await.unwrap();
        run(
            &unborn,
            command(&snapshot, &request(StagingAction::StageAll, None)).unwrap(),
        );
        let staged = crate::status::read("repo".into(), &unborn).await.unwrap();
        run(
            &unborn,
            command(&staged, &request(StagingAction::UnstageAll, None)).unwrap(),
        );
        let unstaged = crate::status::read("repo".into(), &unborn).await.unwrap();
        assert!(unstaged
            .files
            .iter()
            .any(|file| file.categories.contains(&ChangeCategory::Untracked)));
    }
}
