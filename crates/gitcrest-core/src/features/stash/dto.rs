use serde::Serialize;

/// One entry of `git stash list`, newest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StashEntry {
    /// Position in the stash list; `stash@{index}`.
    pub index: usize,
    /// The stash commit; its diff against `base_oid` is the tracked part.
    pub oid: String,
    pub base_oid: Option<String>,
    /// The commit that holds untracked files, for a stash made with `-u`.
    pub untracked_oid: Option<String>,
    /// The branch the stash was made on, when Git recorded one.
    pub branch: Option<String>,
    pub message: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StashList {
    pub repo_id: String,
    pub stashes: Vec<StashEntry>,
}
