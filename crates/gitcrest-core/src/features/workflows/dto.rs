use serde::Deserialize;

use super::service::WorkflowAction;
use crate::rebase;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RebasePreviewQuery {
    pub(super) onto_oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RebaseRequest {
    pub(super) expected_head_oid: String,
    pub(super) expected_onto_oid: String,
    pub(super) preview_revision: String,
    pub(super) todo: Vec<rebase::RebaseTodoItem>,
    pub(super) confirm_drop: bool,
    pub(super) confirm_published_rewrite: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RebaseRollbackRequest {
    pub(super) expected_head_oid: String,
    pub(super) backup_reference: String,
    pub(super) backup_oid: String,
    pub(super) confirm_rollback: bool,
}
