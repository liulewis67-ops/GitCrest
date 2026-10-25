use super::status::ChangeKind;

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub(crate) enum DiffScope {
    WorkingTree,
    Index,
    Commit,
}

/// How much unchanged text a patch carries around each change.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum DiffContext {
    /// Three lines of context: the hunks that staging selections address.
    #[default]
    Hunks,
    /// The whole file as a single hunk, for reading both sides in full.
    FullFile,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiffSelection {
    pub(crate) hunk_index: usize,
    pub(crate) row_index: Option<usize>,
    /// One half of a row that pairs a deleted line with an added line; `None` selects the whole row.
    pub(crate) side: Option<DiffRowSide>,
}

/// The deleted (old) or added (new) line of a change row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiffRowSide {
    Old,
    New,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DiffContentStatus {
    Text,
    Binary,
    Empty,
    Conflicted,
    Ignored,
    Symlink,
    Submodule,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DiffWorktreeEntryKind {
    Regular,
    Missing,
    Symlink,
    Directory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DiffRowKind {
    Context,
    Change,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiffRow {
    pub(crate) kind: DiffRowKind,
    pub(crate) old_line: Option<u32>,
    pub(crate) new_line: Option<u32>,
    pub(crate) old_text: Option<String>,
    pub(crate) new_text: Option<String>,
    pub(crate) patch_change_lines: Vec<usize>,
    pub(crate) old_position: Option<u32>,
    pub(crate) new_position: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiffHunk {
    pub(crate) old_start: u32,
    pub(crate) old_lines: u32,
    pub(crate) new_start: u32,
    pub(crate) new_lines: u32,
    pub(crate) rows: Vec<DiffRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiffDocument {
    pub(crate) repo_id: String,
    pub(crate) path: String,
    pub(crate) revision: String,
    pub(crate) original_path: Option<String>,
    pub(crate) scope: DiffScope,
    pub(crate) change_kind: ChangeKind,
    pub(crate) status: DiffContentStatus,
    pub(crate) hunks: Vec<DiffHunk>,
}
