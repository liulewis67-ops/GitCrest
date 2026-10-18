#[derive(Clone, Debug)]
pub(crate) enum BranchCommand {
    Create {
        name: String,
        checkout: bool,
        worktree_path: Option<String>,
        start_point: Option<String>,
    },
    Switch {
        name: String,
    },
    WorktreeAdd {
        branch: String,
        path: String,
    },
    /// Creates a local branch that tracks `remote_ref` (for example `origin/feature`) in a new worktree.
    WorktreeAddTracking {
        local_branch: String,
        remote_ref: String,
        path: String,
    },
    /// Forgets worktrees whose folders no longer exist (`git worktree prune`).
    WorktreePrune,
    WorktreeRemove {
        path: String,
        force: bool,
    },
    Rename {
        old_name: String,
        new_name: String,
    },
    Delete {
        name: String,
        allow_unmerged: bool,
    },
}

pub(crate) fn is_branch_name_syntactically_valid(name: &str) -> bool {
    !name.is_empty() && name.len() <= 255 && !name.chars().any(char::is_control)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BranchReference {
    pub(crate) full_name: String,
    pub(crate) name: String,
    pub(crate) oid: String,
    pub(crate) upstream: Option<String>,
    pub(crate) upstream_gone: bool,
    pub(crate) ahead: Option<u32>,
    pub(crate) behind: Option<u32>,
    /// Folder of the working tree that has this branch checked out, when there is one.
    pub(crate) worktree_path: Option<String>,
}
