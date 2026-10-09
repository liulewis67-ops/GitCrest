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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusSnapshot {
    pub repo_id: String,
    pub refreshed_at_ms: i64,
    pub files: Vec<StatusFile>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusFile {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub kind: ChangeKind,
    pub categories: Vec<ChangeCategory>,
    pub mode_changed: bool,
}
