use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoteBranchDeleteQuery {
    pub(super) remote_name: String,
    pub(super) remote_branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoteBranchDeleteRequest {
    pub(super) remote_name: String,
    pub(super) remote_branch: String,
    pub(super) expected_remote_oid: String,
    pub(super) preview_revision: String,
    pub(super) confirm_delete: bool,
}
