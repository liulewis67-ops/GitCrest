use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HistoryQuery {
    pub(super) offset: Option<usize>,
    pub(super) limit: Option<usize>,
    pub(super) sha: Option<String>,
    pub(super) author: Option<String>,
    pub(super) message: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) path: Option<String>,
    pub(super) since: Option<String>,
    pub(super) until: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BlameQuery {
    pub(super) path: String,
    pub(super) revision: Option<String>,
}
