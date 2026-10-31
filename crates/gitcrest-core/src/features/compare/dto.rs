use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CompareQuery {
    /// The starting point: a branch, tag, commit or other revision.
    pub base: String,
    /// The other end. Leaving it out compares `base` with the working tree.
    pub head: Option<String>,
    #[serde(default)]
    pub mode: CompareMode,
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
}

/// How the changed files are worked out. The commit lists are the same either way.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CompareMode {
    /// What `head` changed since it left `base`: `git diff base...head`.
    #[default]
    ThreeDot,
    /// The two ends as they are: `git diff base head`.
    TwoDot,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompareCommit {
    pub oid: String,
    pub short_oid: String,
    pub subject: String,
    pub author_name: String,
    pub authored_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompareFile {
    pub path: String,
    pub original_path: Option<String>,
    /// `added`, `deleted`, `modified`, `renamed`, `copied` or `typeChanged`.
    pub kind: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompareList<T> {
    pub items: Vec<T>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CompareResult {
    pub repo_id: String,
    pub base: String,
    pub head: Option<String>,
    pub base_oid: String,
    /// The commit the head side is read at; `None` for the working tree.
    pub head_oid: Option<String>,
    /// The commit the changed files start from: the common ancestor in three-dot mode, `base_oid`
    /// otherwise.
    pub from_oid: String,
    pub merge_base_oid: Option<String>,
    pub mode: CompareMode,
    pub offset: usize,
    pub limit: usize,
    /// Commits on `base` that `head` does not have (`git log head..base`).
    pub only_in_base: CompareList<CompareCommit>,
    /// Commits on `head` that `base` does not have (`git log base..head`).
    pub only_in_head: CompareList<CompareCommit>,
    pub files: CompareList<CompareFile>,
}
