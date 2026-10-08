use serde::{Deserialize, Serialize};

use crate::{diff, diff::DiffScope, shelves};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ShelfSelectionRequest {
    pub(super) path: String,
    pub(super) scope: DiffScope,
    pub(super) revision: String,
    #[serde(default)]
    pub(super) selections: Vec<diff::DiffSelection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ShelfCreateRequest {
    pub(super) name: String,
    pub(super) description: String,
    pub(super) expected_head_oid: Option<String>,
    pub(super) items: Vec<ShelfSelectionRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ShelfDetailResponse {
    pub(super) shelf: shelves::ShelfSnapshot,
    pub(super) patch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ShelfApplyPreviewResponse {
    pub(super) shelf: shelves::ShelfSnapshot,
    pub(super) expected_head_oid: Option<String>,
    pub(super) preview_revision: String,
    pub(super) can_apply_cleanly: bool,
    pub(super) can_apply_with_conflicts: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ShelfApplyRequest {
    pub(super) expected_head_oid: Option<String>,
    pub(super) preview_revision: String,
}
