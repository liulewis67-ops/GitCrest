use serde::{Deserialize, Serialize};

use crate::api::workflow::WorkflowOperationDto;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoteBranchDeleteQuery {
    pub(super) remote_name: String,
    pub(super) remote_branch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteBranchDeletePreviewDto {
    pub(super) repo_id: String,
    pub(super) remote_name: String,
    pub(super) remote_branch: String,
    pub(super) target_ref: String,
    pub(super) expected_remote_oid: String,
    pub(super) current_head_oid: Option<String>,
    pub(super) commits_only_on_remote: u32,
    pub(super) affected_paths: Vec<String>,
    pub(super) omitted_path_count: u32,
    pub(super) operation_in_progress: Option<WorkflowOperationDto>,
    pub(super) preview_revision: String,
    pub(super) can_delete: bool,
}

impl From<super::service::RemoteBranchDeletePreview> for RemoteBranchDeletePreviewDto {
    fn from(preview: super::service::RemoteBranchDeletePreview) -> Self {
        Self {
            repo_id: preview.repo_id,
            remote_name: preview.remote_name,
            remote_branch: preview.remote_branch,
            target_ref: preview.target_ref,
            expected_remote_oid: preview.expected_remote_oid,
            current_head_oid: preview.current_head_oid,
            commits_only_on_remote: preview.commits_only_on_remote,
            affected_paths: preview.affected_paths,
            omitted_path_count: preview.omitted_path_count,
            operation_in_progress: preview.operation_in_progress.map(Into::into),
            preview_revision: preview.preview_revision,
            can_delete: preview.can_delete,
        }
    }
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
    pub(super) strategy: crate::features::remotes::pull::PullStrategy,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PushTargetQuery {
    #[serde(rename = "remoteName")]
    pub(super) remote_name: Option<String>,
    #[serde(rename = "remoteBranch")]
    pub(super) remote_branch: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PushRequest {
    pub(super) expected_local_oid: String,
    pub(super) expected_remote_oid: String,
    pub(super) force_with_lease: bool,
    pub(super) remote_name: String,
    pub(super) remote_branch: String,
}
