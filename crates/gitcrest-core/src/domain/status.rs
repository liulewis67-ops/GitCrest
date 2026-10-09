#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Ignored,
    Conflicted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ChangeCategory {
    Staged,
    Unstaged,
    Untracked,
    Ignored,
    Conflicted,
}
