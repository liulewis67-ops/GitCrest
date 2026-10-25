use serde::{Deserialize, Serialize};

use crate::domain::shelf::ShelfSnapshot;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ShelfDiffScope {
    WorkingTree,
    Index,
    Commit,
}

impl From<ShelfDiffScope> for crate::domain::diff::DiffScope {
    fn from(scope: ShelfDiffScope) -> Self {
        match scope {
            ShelfDiffScope::WorkingTree => Self::WorkingTree,
            ShelfDiffScope::Index => Self::Index,
            ShelfDiffScope::Commit => Self::Commit,
        }
    }
}

impl From<crate::domain::diff::DiffScope> for ShelfDiffScope {
    fn from(scope: crate::domain::diff::DiffScope) -> Self {
        match scope {
            crate::domain::diff::DiffScope::WorkingTree => Self::WorkingTree,
            crate::domain::diff::DiffScope::Index => Self::Index,
            crate::domain::diff::DiffScope::Commit => Self::Commit,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ShelfSnapshotDto {
    shelf_id: String,
    repo_id: String,
    name: String,
    description: String,
    paths: Vec<String>,
    scope: Option<ShelfDiffScope>,
    head_oid: Option<String>,
    created_at_ms: i64,
}

impl From<ShelfSnapshot> for ShelfSnapshotDto {
    fn from(snapshot: ShelfSnapshot) -> Self {
        Self {
            shelf_id: snapshot.shelf_id,
            repo_id: snapshot.repo_id,
            name: snapshot.name,
            description: snapshot.description,
            paths: snapshot.paths,
            scope: snapshot.scope.map(Into::into),
            head_oid: snapshot.head_oid,
            created_at_ms: snapshot.created_at_ms,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ShelfSelectionRequest {
    pub(super) path: String,
    pub(super) scope: ShelfDiffScope,
    pub(super) revision: String,
    #[serde(default)]
    pub(super) selections: Vec<ShelfDiffSelection>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ShelfDiffSelection {
    pub(super) hunk_index: usize,
    #[serde(default)]
    pub(super) row_index: Option<usize>,
    #[serde(default)]
    pub(super) side: Option<crate::domain::diff::DiffRowSide>,
}

impl From<ShelfDiffSelection> for crate::domain::diff::DiffSelection {
    fn from(selection: ShelfDiffSelection) -> Self {
        Self {
            hunk_index: selection.hunk_index,
            row_index: selection.row_index,
            side: selection.side,
        }
    }
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
    pub(super) shelf: ShelfSnapshotDto,
    pub(super) patch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ShelfApplyPreviewResponse {
    pub(super) shelf: ShelfSnapshotDto,
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
