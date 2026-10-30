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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeleteTagBody {
    pub name: String,
    /// The commit the tag pointed at when it was reviewed.
    pub expected_target_oid: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeletedTag {
    pub repo_id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoteTagQuery {
    pub remote_name: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteTagPreview {
    pub repo_id: String,
    pub remote_name: String,
    pub name: String,
    /// The object the remote's tag points at, or null when the remote has no such tag.
    pub remote_oid: Option<String>,
    /// The object the local tag points at, or null when there is no local tag.
    pub local_oid: Option<String>,
    /// Both sides have the tag and it is the same object.
    pub same_as_local: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PushTagBody {
    pub remote_name: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeleteRemoteTagBody {
    pub remote_name: String,
    pub name: String,
    pub expected_remote_oid: String,
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
