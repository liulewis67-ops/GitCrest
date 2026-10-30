use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreateTagBody {
    pub name: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TagListQuery {
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
    /// Case-insensitive part of the tag name.
    pub filter: Option<String>,
    /// Comma-separated commit ids; only tags that point at one of them are listed.
    pub targets: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TagEntry {
    pub name: String,
    /// The commit the tag points at.
    pub target_oid: String,
    pub annotated: bool,
    pub tagger_name: Option<String>,
    pub created_at_ms: Option<i64>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TagPage {
    pub repo_id: String,
    pub offset: usize,
    pub limit: usize,
    pub tags: Vec<TagEntry>,
    pub next_offset: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatedTag {
    pub repo_id: String,
    pub name: String,
    pub full_name: String,
    pub oid: String,
}
