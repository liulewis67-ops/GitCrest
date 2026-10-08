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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoteRequest {
    pub(super) name: String,
    #[serde(default)]
    pub(super) url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoteNameRequest {
    pub(super) name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DefaultRemoteRequest {
    pub(super) name: RequiredNullableRemoteName,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum RequiredNullableRemoteName {
    Value(String),
    Null(()),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BranchUpstreamRequest {
    pub(super) local_branch: String,
    pub(super) remote_name: String,
    pub(super) remote_branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FetchRequest {
    pub(super) prune: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PullRequest {
    pub(super) expected_local_oid: String,
    pub(super) expected_tracking_oid: String,
    pub(super) strategy: crate::pull::PullStrategy,
}
