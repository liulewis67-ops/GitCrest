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
    pub(super) is_clean: bool,
    pub(super) dirty_files: Vec<String>,
    pub(super) potentially_overwritten_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BranchNameQuery {
    pub(super) name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SwitchBranchRequest {
    pub(super) name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreateBranchRequest {
    pub(super) name: String,
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
