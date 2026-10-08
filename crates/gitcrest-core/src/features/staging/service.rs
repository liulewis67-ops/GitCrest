use std::{ffi::OsString, path::Component};

use super::dto::{StagingAction, StagingPatchAction, StagingPatchRequest, StagingRequest};
use crate::{
    features::diff::DiffScope,
    status::{ChangeCategory, ChangeKind, StatusFile, StatusSnapshot},
};

#[derive(Debug, PartialEq, Eq)]
pub enum StagingError {
    InvalidRequest,
    FileNotChanged,
    FileNotStaged,
    ConflictMustBeResolvedFirst,
    StaleSelection,
}

pub struct StagingCommand {
    pub arguments: Vec<OsString>,
    pub input: Option<Vec<u8>>,
    pub label: &'static str,
    pub log_label: &'static str,
}

pub fn patch_command(action: StagingPatchAction, patch: Vec<u8>) -> StagingCommand {
    let (arguments, label, log_label): (Vec<OsString>, &'static str, &'static str) = match action {
        StagingPatchAction::Stage => (
            ["apply", "--cached", "--unidiff-zero"]
                .into_iter()
                .map(OsString::from)
                .collect(),
            "Stage selected diff",
            "git apply --cached <selected patch>",
        ),
        StagingPatchAction::Unstage => (
            ["apply", "--cached", "--reverse", "--unidiff-zero"]
                .into_iter()
                .map(OsString::from)
                .collect(),
            "Unstage selected diff",
            "git apply --cached --reverse <selected patch>",
        ),
    };
    StagingCommand {
        arguments,
        input: Some(patch),
        label,
        log_label,
    }
}

pub fn undo_command(reverse_patch: Vec<u8>) -> StagingCommand {
    StagingCommand {
        arguments: ["apply", "--cached"]
            .into_iter()
            .map(OsString::from)
            .collect(),
        input: Some(reverse_patch),
        label: "Undo recent staging change",
        log_label: "git apply --cached <staging undo patch>",
    }
}

pub fn discard_patch_command(patch: Vec<u8>) -> StagingCommand {
    StagingCommand {
        arguments: ["apply", "--reverse", "--unidiff-zero"]
            .into_iter()
            .map(OsString::from)
            .collect(),
        input: Some(patch),
        label: "Discard selected working-tree changes",
        log_label: "git apply --reverse <selected working-tree patch>",
    }
}

pub fn undo_discard_command(patch: Vec<u8>) -> StagingCommand {
    StagingCommand {
        arguments: ["apply", "--unidiff-zero"]
            .into_iter()
            .map(OsString::from)
            .collect(),
        input: Some(patch),
        label: "Undo selected working-tree discard",
        log_label: "git apply <discard undo patch>",
    }
}

pub fn validate_patch_request(
    request: &StagingPatchRequest,
    file: &StatusFile,
) -> Result<(), StagingError> {
    validate_relative_path(&request.path)?;
    if request.selections.is_empty() || request.revision.is_empty() {
        return Err(StagingError::InvalidRequest);
    }
    if file.categories.contains(&ChangeCategory::Conflicted) || file.kind == ChangeKind::Conflicted
    {
        return Err(StagingError::ConflictMustBeResolvedFirst);
    }
    match (request.action, request.scope) {
        (StagingPatchAction::Stage, DiffScope::WorkingTree)
            if file.categories.iter().any(|category| {
                matches!(
                    category,
                    ChangeCategory::Unstaged | ChangeCategory::Untracked
                )
            }) =>
        {
            Ok(())
        }
        (StagingPatchAction::Unstage, DiffScope::Index)
            if file.categories.contains(&ChangeCategory::Staged) =>
        {
            Ok(())
        }
        (StagingPatchAction::Unstage, DiffScope::Index) => Err(StagingError::FileNotStaged),
        _ => Err(StagingError::InvalidRequest),
    }
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
            input: None,
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
        input: None,
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
        input: None,
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

    fn run_with_input(root: &Path, arguments: &[&str], input: &[u8]) {
        use std::io::Write;
        let mut child = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(arguments)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output(root: &Path, arguments: &[&str]) -> String {
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
        String::from_utf8_lossy(&output.stdout).into_owned()
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

    #[tokio::test]
    async fn selecting_one_hunk_preserves_unselected_worktree_changes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet"]);
        git(&root, &["config", "user.name", "GitCrest Test"]);
        git(
            &root,
            &["config", "user.email", "gitcrest-test@example.invalid"],
        );
        let base = (0..24)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        std::fs::write(root.join("multi.txt"), base).unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "--quiet", "-m", "base"]);
        let mut lines = (0..24)
            .map(|line| format!("line {line}\n"))
            .collect::<Vec<_>>();
        lines[1] = "staged first\n".into();
        lines[21] = "unstaged last\n".into();
        std::fs::write(root.join("multi.txt"), lines.concat()).unwrap();

        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == "multi.txt")
            .unwrap();
        let working = crate::features::diff::read_with_patch(
            "repo".into(),
            &root,
            file,
            DiffScope::WorkingTree,
        )
        .await
        .unwrap();
        assert_eq!(working.document.hunks.len(), 2);
        assert!(working.document.revision.starts_with("sha256:"));
        let selected = crate::features::diff::select_hunks(&working, &[0]).unwrap();
        run_with_input(&root, &["apply", "--cached", "--unidiff-zero"], &selected);

        let cached = git_output(&root, &["diff", "--cached", "--", "multi.txt"]);
        let unstaged = git_output(&root, &["diff", "--", "multi.txt"]);
        assert!(cached.contains("+staged first"));
        assert!(!cached.contains("unstaged last"));
        assert!(unstaged.contains("+unstaged last"));
        assert!(!unstaged.contains("staged first"));

        let remaining_snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        let file = remaining_snapshot
            .files
            .iter()
            .find(|file| file.path == "multi.txt")
            .unwrap();
        let remaining_diff = crate::features::diff::read_with_patch(
            "repo".into(),
            &root,
            file,
            DiffScope::WorkingTree,
        )
        .await
        .unwrap();
        let selected = crate::features::diff::select_hunks(&remaining_diff, &[0]).unwrap();
        run_with_input(&root, &["apply", "--cached", "--unidiff-zero"], &selected);

        let after_stage = crate::status::read("repo".into(), &root).await.unwrap();
        let file = after_stage
            .files
            .iter()
            .find(|file| file.path == "multi.txt")
            .unwrap();
        let staged_diff =
            crate::features::diff::read_with_patch("repo".into(), &root, file, DiffScope::Index)
                .await
                .unwrap();
        assert_eq!(staged_diff.document.hunks.len(), 2);
        let revision = staged_diff.document.revision.clone();
        let selected = crate::features::diff::select_hunks(&staged_diff, &[0]).unwrap();
        run_with_input(
            &root,
            &["apply", "--cached", "--reverse", "--unidiff-zero"],
            &selected,
        );
        let still_staged = git_output(&root, &["diff", "--cached", "--", "multi.txt"]);
        let remaining = git_output(&root, &["diff", "--", "multi.txt"]);
        assert!(still_staged.contains("+unstaged last"));
        assert!(!still_staged.contains("staged first"));
        assert!(remaining.contains("+staged first"));
        assert!(!remaining.contains("unstaged last"));
        let refreshed = crate::status::read("repo".into(), &root).await.unwrap();
        let file = refreshed
            .files
            .iter()
            .find(|file| file.path == "multi.txt")
            .unwrap();
        let new_diff =
            crate::features::diff::read_with_patch("repo".into(), &root, file, DiffScope::Index)
                .await
                .unwrap();
        assert_ne!(revision, new_diff.document.revision);
    }

    #[tokio::test]
    async fn selecting_one_change_row_preserves_adjacent_edits_and_crlf_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet"]);
        git(&root, &["config", "user.name", "GitCrest Test"]);
        git(
            &root,
            &["config", "user.email", "gitcrest-test@example.invalid"],
        );
        git(&root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("lines.txt"), "one\r\ntwo\r\nthree\r\nfour\r\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "--quiet", "-m", "base"]);
        std::fs::write(
            root.join("lines.txt"),
            "one\r\nchanged two\r\nchanged three\r\nfour\r\n",
        )
        .unwrap();

        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == "lines.txt")
            .unwrap();
        let diff = crate::features::diff::read_with_patch(
            "repo".into(),
            &root,
            file,
            DiffScope::WorkingTree,
        )
        .await
        .unwrap();
        assert_eq!(diff.document.hunks.len(), 1);
        assert_eq!(
            diff.document.hunks[0]
                .rows
                .iter()
                .filter(|row| row.kind == crate::features::diff::DiffRowKind::Change)
                .count(),
            2
        );
        let all_rows = crate::features::diff::select_rows(&diff, &[(0, 1), (0, 2)]).unwrap();
        run_with_input(
            &root,
            &["apply", "--cached", "--check", "--unidiff-zero"],
            &all_rows,
        );
        let patch = crate::features::diff::select_rows(&diff, &[(0, 1)]).unwrap();
        run_with_input(&root, &["apply", "--cached", "--unidiff-zero"], &patch);
        let cached = git_output(&root, &["diff", "--cached", "--", "lines.txt"]);
        let unstaged = git_output(&root, &["diff", "--", "lines.txt"]);
        assert!(cached.contains("+changed two\r"));
        assert!(!cached.contains("changed three"));
        assert!(unstaged.contains("+changed three\r"));
        assert!(!unstaged.contains("+changed two"));
    }

    #[tokio::test]
    async fn selecting_one_added_line_stages_only_that_line() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet"]);
        std::fs::write(root.join("new file.txt"), "first line\nsecond line\n").unwrap();
        let snapshot = crate::status::read("repo".into(), &root).await.unwrap();
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == "new file.txt")
            .unwrap();
        let diff = crate::features::diff::read_with_patch(
            "repo".into(),
            &root,
            file,
            DiffScope::WorkingTree,
        )
        .await
        .unwrap();
        let selected = crate::features::diff::select_rows(&diff, &[(0, 0)]).unwrap();
        run_with_input(&root, &["apply", "--cached", "--unidiff-zero"], &selected);
        let cached = git_output(&root, &["diff", "--cached", "--", "new file.txt"]);
        assert!(cached.contains("+first line"));
        assert!(!cached.contains("second line"));
        assert_eq!(
            std::fs::read_to_string(root.join("new file.txt")).unwrap(),
            "first line\nsecond line\n"
        );
    }
}
