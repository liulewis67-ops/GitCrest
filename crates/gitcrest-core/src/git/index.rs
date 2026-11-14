use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

use crate::domain::{
    diff::DiffScope,
    staging::{ShelfPatchAction, StagingOperation},
};
/// Paths go to Git on stdin, NUL-separated, so a long selection never exceeds the command-line limit.
fn nul_separated(paths: Vec<String>) -> Vec<u8> {
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    input
}

/// Whether the operation writes the index (and so needs Git's index lock). The two patch checks only read.
pub(crate) fn changes_index(operation: &StagingOperation) -> bool {
    !matches!(
        operation,
        StagingOperation::ApplyShelfPatch {
            action: ShelfPatchAction::CheckRestore | ShelfPatchAction::CheckCleanup,
            ..
        }
    )
}

/// How long an index change waits for an outside process to release `index.lock`, and how often it looks.
const INDEX_LOCK_POLL: Duration = Duration::from_millis(50);
const INDEX_LOCK_POLLS: u32 = 40;

/// The directory holding this working tree's index: `.git` itself, or what a linked worktree's `.git` file points to.
fn git_dir(repository_path: &Path) -> Option<PathBuf> {
    let dot_git = repository_path.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = PathBuf::from(
        text.lines()
            .find_map(|line| line.strip_prefix("gitdir:"))?
            .trim(),
    );
    Some(if target.is_absolute() {
        target
    } else {
        repository_path.join(target)
    })
}

/// GitCrest's own index writes are serialized by its task locks, so a lock that is held when one is about to run
/// belongs to something else, such as an editor or a terminal running `git status`. Those hold it for a moment, and Git
/// fails at once instead of waiting, so give the other process a short, bounded chance to finish. A stale lock only
/// costs the wait; the command then fails with Git's own message as before.
pub(crate) async fn wait_for_index_lock(repository_path: &Path) {
    let Some(lock) = git_dir(repository_path).map(|dir| dir.join("index.lock")) else {
        return;
    };
    for _ in 0..INDEX_LOCK_POLLS {
        if !lock.exists() {
            return;
        }
        tokio::time::sleep(INDEX_LOCK_POLL).await;
    }
}

pub(crate) fn staging_invocation(
    operation: StagingOperation,
) -> (Vec<OsString>, Option<Vec<u8>>, &'static str, &'static str) {
    let (arguments, input, label, log_label) = match operation {
        StagingOperation::StageAll => (
            ["--literal-pathspecs", "add", "--all", "--", "."]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>(),
            None,
            "Stage all changes",
            "git add --all <repository>",
        ),
        StagingOperation::UnstageAll => (
            ["reset", "--mixed"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>(),
            None,
            "Unstage all changes",
            "git reset --mixed",
        ),
        StagingOperation::StagePath(path) => {
            let mut arguments = ["--literal-pathspecs", "add", "--"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>();
            arguments.push(path.into());
            return (arguments, None, "Stage file", "git add <selected path>");
        }
        StagingOperation::StagePaths(paths) => (
            [
                "--literal-pathspecs",
                "add",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>(),
            Some(nul_separated(paths)),
            "Stage selected files",
            "git add <selected paths>",
        ),
        StagingOperation::UnstageSelectedPaths(paths) => (
            [
                "--literal-pathspecs",
                "restore",
                "--staged",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>(),
            Some(nul_separated(paths)),
            "Unstage selected files",
            "git restore --staged <selected paths>",
        ),
        StagingOperation::UnstageAddedPaths(paths) => (
            [
                "--literal-pathspecs",
                "rm",
                "--cached",
                "--force",
                "--quiet",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ]
            .into_iter()
            .map(OsString::from)
            .collect::<Vec<_>>(),
            Some(nul_separated(paths)),
            "Unstage added files",
            "git rm --cached <selected paths>",
        ),
        StagingOperation::UnstagePath(path) => {
            let mut arguments = ["--literal-pathspecs", "restore", "--staged", "--"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>();
            arguments.push(path.into());
            return (
                arguments,
                None,
                "Unstage file",
                "git restore --staged <selected path>",
            );
        }
        StagingOperation::UnstageAddedPath(path) => {
            let mut arguments = ["--literal-pathspecs", "rm", "--cached", "--force", "--"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>();
            arguments.push(path.into());
            return (
                arguments,
                None,
                "Unstage added file",
                "git rm --cached <selected path>",
            );
        }
        StagingOperation::UnstageRenamedPath {
            original_path,
            path,
        } => {
            let mut arguments = ["--literal-pathspecs", "restore", "--staged", "--"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>();
            arguments.push(original_path.into());
            arguments.push(path.into());
            return (
                arguments,
                None,
                "Unstage renamed file",
                "git restore --staged <selected paths>",
            );
        }
        StagingOperation::StagePatch(patch) => (
            ["apply", "--cached", "--unidiff-zero"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>(),
            Some(patch),
            "Stage selected diff",
            "git apply --cached <selected patch>",
        ),
        StagingOperation::UnstagePatch(patch) => (
            ["apply", "--cached", "--reverse", "--unidiff-zero"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>(),
            Some(patch),
            "Unstage selected diff",
            "git apply --cached --reverse <selected patch>",
        ),
        StagingOperation::UndoStaging(patch) => (
            ["apply", "--cached"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>(),
            Some(patch),
            "Undo recent staging change",
            "git apply --cached <staging undo patch>",
        ),
        StagingOperation::DiscardPatch(patch) => (
            ["apply", "--reverse", "--unidiff-zero"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>(),
            Some(patch),
            "Discard selected working-tree changes",
            "git apply --reverse <selected working-tree patch>",
        ),
        StagingOperation::UndoDiscard(patch) => (
            ["apply", "--unidiff-zero"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>(),
            Some(patch),
            "Undo selected working-tree discard",
            "git apply <discard undo patch>",
        ),
        StagingOperation::ApplyShelfPatch {
            patch,
            scope,
            action,
        } => {
            let mut arguments = vec![OsString::from("apply")];
            match action {
                ShelfPatchAction::CheckRestore => {
                    arguments.push("--check".into());
                    if scope == DiffScope::Index {
                        arguments.push("--cached".into());
                    }
                    return (
                        arguments,
                        Some(patch),
                        "Check shelve patch",
                        "git apply <shelve patch>",
                    );
                }
                ShelfPatchAction::CheckCleanup => {
                    arguments.push("--check".into());
                    arguments.push("--reverse".into());
                    if scope == DiffScope::Index {
                        arguments.push("--cached".into());
                    }
                    return (
                        arguments,
                        Some(patch),
                        "Check shelve patch",
                        "git apply <shelve patch>",
                    );
                }
                ShelfPatchAction::Cleanup => {
                    arguments.push("--reverse".into());
                    if scope == DiffScope::Index {
                        arguments.push("--cached".into());
                    }
                    return (
                        arguments,
                        Some(patch),
                        "Remove shelved changes",
                        "git apply <shelve patch>",
                    );
                }
                ShelfPatchAction::Rollback => {
                    if scope == DiffScope::Index {
                        arguments.push("--cached".into());
                    }
                    return (
                        arguments,
                        Some(patch),
                        "Restore shelved changes",
                        "git apply <shelve patch>",
                    );
                }
                ShelfPatchAction::Restore => {
                    if scope == DiffScope::Index {
                        arguments.push("--index".into());
                    }
                    return (
                        arguments,
                        Some(patch),
                        "Apply saved shelf",
                        "git apply <shelf patch>",
                    );
                }
                ShelfPatchAction::UndoRestore => {
                    arguments.push("--reverse".into());
                    if scope == DiffScope::Index {
                        arguments.push("--index".into());
                    }
                    return (
                        arguments,
                        Some(patch),
                        "Undo saved shelf apply",
                        "git apply --reverse <shelf patch>",
                    );
                }
            }
        }
        StagingOperation::RestoreShelfIndex { paths, tree } => {
            let mut arguments = ["reset", "-q", &tree, "--"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>();
            arguments.extend(paths.into_iter().map(OsString::from));
            return (
                arguments,
                None,
                "Keep shelf changes unstaged",
                "git reset -q <pre-apply index tree> -- <shelf paths>",
            );
        }
    };
    (arguments, input, label, log_label)
}
