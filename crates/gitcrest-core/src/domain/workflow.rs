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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkflowBackupNamespace {
    Rebase,
    Reset,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowBackupReference {
    pub(crate) reference: String,
    pub(crate) oid: String,
    pub(crate) subject: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowResetComparison {
    pub(crate) commits_removed: u32,
    pub(crate) commits_added: u32,
    pub(crate) changed_paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowCommitSubject {
    pub(crate) oid: String,
    pub(crate) subject: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowRebaseCommitList {
    pub(crate) commits: Vec<WorkflowCommitSubject>,
    pub(crate) omitted_commit_count: u32,
    pub(crate) published_commit_oids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkflowRemoteBranchComparison {
    pub(crate) commits_only_on_remote: u32,
    pub(crate) affected_paths: Vec<String>,
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

/// How a merge target relates to the current HEAD.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeKind {
    /// The target is already contained in HEAD, so merging changes nothing.
    UpToDate,
    /// HEAD is contained in the target, so the branch pointer can simply move.
    FastForward,
    /// The histories diverged and a merge commit is needed.
    MergeCommit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MergeRelation {
    pub kind: MergeKind,
    pub incoming_commit_count: u32,
}
