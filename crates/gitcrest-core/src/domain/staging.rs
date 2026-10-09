use super::diff::DiffScope;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum StagingOperation {
    StageAll,
    UnstageAll,
    StagePath(String),
    UnstagePath(String),
    UnstageAddedPath(String),
    UnstageRenamedPath {
        original_path: String,
        path: String,
    },
    StagePatch(Vec<u8>),
    UnstagePatch(Vec<u8>),
    UndoStaging(Vec<u8>),
    DiscardPatch(Vec<u8>),
    UndoDiscard(Vec<u8>),
    ApplyShelfPatch {
        patch: Vec<u8>,
        scope: DiffScope,
        action: ShelfPatchAction,
    },
    UnstagePaths(Vec<String>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShelfPatchAction {
    CheckRestore,
    CheckCleanup,
    Cleanup,
    Rollback,
    Restore,
    UndoRestore,
    RestoreThreeWay,
}
