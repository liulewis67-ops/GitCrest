use serde::Deserialize;

use super::service::DiffScope;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiffQuery {
    pub(super) path: String,
    pub(super) scope: DiffScope,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CommitDiffQuery {
    pub(super) path: String,
}
