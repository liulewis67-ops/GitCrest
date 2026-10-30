use serde::{Deserialize, Serialize};

/// Which pattern to write for a path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum IgnoreMode {
    /// Exactly this file or folder.
    File,
    /// Every file with this extension, anywhere.
    Extension,
    /// The folder that holds this path.
    Folder,
}

/// Where the rule is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum IgnoreTarget {
    /// The `.gitignore` at the repository root, shared with the team.
    Gitignore,
    /// `.git/info/exclude`, private to this clone.
    Exclude,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IgnoreRequest {
    pub path: String,
    pub mode: IgnoreMode,
    pub target: IgnoreTarget,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IgnorePreviewQuery {
    pub path: String,
    pub mode: IgnoreMode,
    pub target: IgnoreTarget,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IgnoreRule {
    pub repo_id: String,
    /// The line that is, or would be, added.
    pub line: String,
    /// The file the line goes into, relative to the repository (`.gitignore`) or to the Git directory.
    pub file: String,
    /// The same line is already in that file.
    pub already_present: bool,
}
