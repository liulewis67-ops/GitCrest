use super::status::ChangeKind;

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub(crate) enum DiffScope {
    WorkingTree,
    Index,
    Commit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiffSelection {
    pub(crate) hunk_index: usize,
    pub(crate) row_index: Option<usize>,
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
