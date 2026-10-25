use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequest {
    pub message: String,
    #[serde(default)]
    pub amend: bool,
    #[serde(default)]
    pub sign_off: bool,
    #[serde(default)]
    pub sign: bool,
    #[serde(default)]
    pub selections: Vec<CommitSelection>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitSelection {
    pub path: String,
    pub revision: String,
    pub selections: Vec<CommitDiffSelection>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitDiffSelection {
    pub hunk_index: usize,
    #[serde(default)]
    pub row_index: Option<usize>,
    #[serde(default)]
    pub side: Option<crate::domain::diff::DiffRowSide>,
}

impl From<CommitDiffSelection> for crate::domain::diff::DiffSelection {
    fn from(selection: CommitDiffSelection) -> Self {
        Self {
            hunk_index: selection.hunk_index,
            row_index: selection.row_index,
            side: selection.side,
        }
    }
}
