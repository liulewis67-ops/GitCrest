use std::ffi::OsString;

use crate::domain::{
    diff::DiffScope,
    staging::{ShelfPatchAction, StagingOperation},
};
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
                ShelfPatchAction::RestoreThreeWay => {
                    arguments.extend(["--3way".into(), "--index".into()]);
                    return (
                        arguments,
                        Some(patch),
                        "Apply shelf with three-way conflict resolution",
                        "git apply --3way --index <shelf patch>",
                    );
                }
            }
        }
        StagingOperation::UnstagePaths(paths) => {
            let mut arguments = ["reset", "-q", "HEAD", "--"]
                .into_iter()
                .map(OsString::from)
                .collect::<Vec<_>>();
            arguments.extend(paths.into_iter().map(OsString::from));
            return (
                arguments,
                None,
                "Keep shelf changes unstaged",
                "git reset -q HEAD -- <shelf paths>",
            );
        }
    };
    (arguments, input, label, log_label)
}
