use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReflogQuery {
    /// `HEAD`, or a local branch as `refs/heads/<name>`.
    pub r#ref: Option<String>,
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
}

/// One step of a reference's history, newest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReflogEntry {
    /// Position in the reflog; `<ref>@{index}`.
    pub index: usize,
    pub oid: String,
    pub selector: String,
    /// Git's description of the step, such as `commit: fix typo` or `checkout: moving from a to b`.
    pub message: String,
    pub created_at_ms: i64,
}

/// A safety ref GitCrest made before a rebase or reset, so the earlier state can be found again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BackupRef {
    pub reference: String,
    pub oid: String,
    /// `rebase` or `reset`.
    pub kind: String,
    pub subject: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReflogPage {
    pub repo_id: String,
    pub r#ref: String,
    pub offset: usize,
    pub limit: usize,
    pub entries: Vec<ReflogEntry>,
    pub next_offset: Option<usize>,
    /// GitCrest's own backup refs; only sent with the first page.
    pub backups: Vec<BackupRef>,
}
