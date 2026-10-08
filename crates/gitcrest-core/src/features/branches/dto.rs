use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BranchFavoriteRequest {
    pub(super) full_name: String,
    pub(super) favorite: bool,
}
