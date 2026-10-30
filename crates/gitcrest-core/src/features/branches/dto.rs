use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BranchFavoriteRequest {
    pub(super) full_name: String,
    pub(super) favorite: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BranchSwitchPreflight {
    pub(super) repo_id: String,
    pub(super) current: Option<String>,
    pub(super) target: String,
    /// The local branch that will be checked out; for a remote target, the branch that tracks it.
    pub(super) local_branch: String,
    /// A remote target has no local branch tracking it yet, so one is created.
    pub(super) creates_local_branch: bool,
    /// The target is a commit, so HEAD will be detached.
    pub(super) detached: bool,
    pub(super) is_clean: bool,
    pub(super) dirty_files: Vec<String>,
    pub(super) potentially_overwritten_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BranchNameQuery {
    pub(super) name: String,
    /// `name` is a remote-tracking branch such as `origin/feature`.
    #[serde(default)]
    pub(super) remote: bool,
    /// `name` is a commit id, checked out with a detached HEAD.
    #[serde(default)]
    pub(super) commit: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SwitchBranchRequest {
    pub(super) name: String,
    /// `name` is a remote-tracking branch such as `origin/feature`: it is fetched first, then
    /// checked out through a local tracking branch that is created or fast-forwarded as needed.
    #[serde(default)]
    pub(super) remote: bool,
    /// `name` is a commit id: it is checked out with a detached HEAD.
    #[serde(default)]
    pub(super) commit: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreateBranchRequest {
    pub(super) name: String,
    #[serde(default)]
    pub(super) checkout: bool,
    #[serde(default)]
    pub(super) worktree_path: Option<String>,
    #[serde(default)]
    pub(super) start_point: Option<String>,
    /// Ignored local files (such as .env) to copy into the new worktree; only used with worktreePath.
    #[serde(default)]
    pub(super) copy_files: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RenameBranchRequest {
    pub(super) name: String,
    pub(super) new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BranchNameRequest {
    pub(super) name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeleteBranchRequest {
    pub(super) name: String,
    pub(super) allow_unmerged: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BranchDeletePreview {
    pub(super) name: String,
    pub(super) is_current: bool,
    pub(super) unmerged_commit_count: u32,
    pub(super) requires_confirmation: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorktreeInfo {
    pub(super) path: String,
    pub(super) head: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) detached: bool,
    pub(super) locked: bool,
    pub(super) prunable: bool,
    pub(super) is_current: bool,
    pub(super) is_main: bool,
    pub(super) is_dirty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorktreeSnapshot {
    pub(super) repo_id: String,
    pub(super) worktrees: Vec<WorktreeInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoveWorktreeRequest {
    pub(super) path: String,
    #[serde(default)]
    pub(super) force: bool,
    /// Also deletes the branch the worktree had checked out, once the folder is gone.
    #[serde(default)]
    pub(super) delete_branch: bool,
    /// Lets `delete_branch` remove a branch whose commits are not merged into the current branch.
    #[serde(default)]
    pub(super) allow_unmerged: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AddWorktreeRequest {
    pub(super) branch: String,
    pub(super) path: String,
    /// `branch` names a remote-tracking branch such as `origin/feature`; a local tracking branch is created.
    #[serde(default)]
    pub(super) from_remote: bool,
    /// Ignored local files (such as .env) to copy into the new worktree.
    #[serde(default)]
    pub(super) copy_files: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorktreeFolderQuery {
    pub(super) path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorktreeFolderCheck {
    /// `ok`, `notAbsolute`, `notEmpty` or `isFile`.
    pub(super) status: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CopyableFile {
    pub(super) path: String,
    pub(super) size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CopyableFiles {
    pub(super) files: Vec<CopyableFile>,
    pub(super) omitted_count: usize,
}
