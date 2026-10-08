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
