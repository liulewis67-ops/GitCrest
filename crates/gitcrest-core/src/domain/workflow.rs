#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RebaseAction {
    Pick,
    Reword,
    Edit,
    Squash,
    Fixup,
    Drop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkflowRecoveryAction {
    Continue,
    Skip,
    Abort,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkflowAction {
    Merge,
    CherryPick,
    Revert,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkflowOperation {
    Merge,
    CherryPick,
    Revert,
    Rebase,
    ShelfApply,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowState {
    pub(crate) dirty_paths: Vec<String>,
    pub(crate) omitted_dirty_path_count: u32,
    pub(crate) conflicted_paths: Vec<String>,
    pub(crate) omitted_conflicted_path_count: u32,
    pub(crate) operation: Option<WorkflowOperation>,
}

impl RebaseAction {
    pub(crate) fn git_keyword(self) -> &'static str {
        match self {
            Self::Pick | Self::Reword => "pick",
            Self::Edit => "edit",
            Self::Squash => "squash",
            Self::Fixup => "fixup",
            Self::Drop => "drop",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RebaseTodoItem {
    pub(crate) oid: String,
    pub(crate) action: RebaseAction,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RebaseCommitSubject {
    pub(crate) oid: String,
    pub(crate) subject: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RebaseExecutionPlan {
    pub(crate) expected_head_oid: String,
    pub(crate) onto_oid: String,
    pub(crate) commits: Vec<RebaseCommitSubject>,
    pub(crate) todo: Vec<RebaseTodoItem>,
}
