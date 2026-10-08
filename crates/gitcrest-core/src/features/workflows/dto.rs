use serde::Deserialize;

use super::service::WorkflowAction;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowPreflightQuery {
    pub(super) action: WorkflowAction,
    pub(super) target_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WorkflowRequest {
    pub(super) action: WorkflowAction,
    pub(super) target_oid: String,
    pub(super) expected_head_oid: String,
}
