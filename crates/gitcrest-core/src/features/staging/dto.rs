use serde::{Deserialize, Serialize};

use crate::features::diff::DiffScope;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StagingAction {
    StageFile,
    UnstageFile,
    StageAll,
    UnstageAll,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StagingPatchAction {
    Stage,
    Unstage,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagingPatchRequest {
    pub action: StagingPatchAction,
    pub path: String,
    pub scope: DiffScope,
    pub revision: String,
    pub selections: Vec<StagingDiffSelection>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscardPatchRequest {
    pub path: String,
    pub revision: String,
    pub selections: Vec<StagingDiffSelection>,
    pub confirm_discard: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagingDiffSelection {
    pub hunk_index: usize,
    #[serde(default)]
    pub row_index: Option<usize>,
}

impl From<StagingDiffSelection> for crate::domain::diff::DiffSelection {
    fn from(selection: StagingDiffSelection) -> Self {
        Self {
            hunk_index: selection.hunk_index,
            row_index: selection.row_index,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StagingRequest {
    pub action: StagingAction,
    #[serde(default)]
    pub path: Option<String>,
}
