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
