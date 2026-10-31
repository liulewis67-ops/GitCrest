use serde::{Deserialize, Serialize};

/// Where a submodule stands compared with the commit the superproject records for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum SubmoduleState {
    /// Never initialized or cloned here: there is no checkout to open.
    Uninitialized,
    /// Checked out at the recorded commit.
    UpToDate,
    /// Checked out at a different commit than the superproject records.
    OutOfDate,
    /// The superproject's index has an unresolved conflict on this path.
    Conflicted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SubmoduleEntry {
    pub name: String,
    /// Repository-relative path of the checkout.
    pub path: String,
    pub url: Option<String>,
    /// The commit the superproject's index points the path at.
    pub recorded_oid: Option<String>,
    /// The commit the last commit (`HEAD`) points the path at.
    pub committed_oid: Option<String>,
    /// The commit that is checked out in the submodule now; `None` until it is initialized.
    pub checked_out_oid: Option<String>,
    pub state: SubmoduleState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SubmoduleList {
    pub repo_id: String,
    pub items: Vec<SubmoduleEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SubmoduleUpdateRequest {
    /// Submodule paths from the list; empty updates all of them.
    #[serde(default)]
    pub paths: Vec<String>,
    /// Also initialize submodules that were never cloned (`--init`).
    #[serde(default)]
    pub init: bool,
}
