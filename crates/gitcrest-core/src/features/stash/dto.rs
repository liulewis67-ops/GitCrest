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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StashPreviewQuery {
    pub oid: String,
}

/// What applying a stash entry would touch, checked against the working tree as it is now.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StashPreview {
    pub repo_id: String,
    pub oid: String,
    pub index: usize,
    pub head_oid: Option<String>,
    pub base_oid: Option<String>,
    pub paths: Vec<String>,
    pub omitted_path_count: usize,
    /// Paths with local changes that may need conflict resolution.
    pub overlapping_dirty_paths: Vec<String>,
    pub operation_in_progress: bool,
    pub can_apply: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StashApplyRequest {
    pub oid: String,
    /// Apply and then drop the entry, but only when it applied cleanly.
    pub pop: bool,
    pub expected_head_oid: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StashDropRequest {
    pub oid: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StashDropped {
    pub repo_id: String,
    pub oid: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StashImportRequest {
    pub oid: String,
    /// Name for the shelf; the stash message when empty.
    pub name: Option<String>,
    /// Drop the stash entry once the shelf is saved.
    pub drop_after: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum StashDropStatus {
    NotRequested,
    Dropped,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StashImported {
    pub repo_id: String,
    pub shelf_id: String,
    pub name: String,
    pub path_count: usize,
    pub dropped: bool,
    pub drop_status: StashDropStatus,
}
