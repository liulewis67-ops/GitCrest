use serde::Deserialize;

use crate::features::diff::DiffSelection;

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
    pub selections: Vec<DiffSelection>,
}
