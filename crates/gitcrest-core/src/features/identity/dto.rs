use serde::{Deserialize, Serialize};

/// The author identity Git would use for a commit, with the config scope each value comes from.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitIdentity {
    pub(super) name: Option<String>,
    pub(super) email: Option<String>,
    pub(super) name_scope: Option<String>,
    pub(super) email_scope: Option<String>,
    /// Both a name and an email are set, so a commit will not stop at "tell me who you are".
    pub(super) resolved: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SetIdentityRequest {
    pub(super) name: String,
    pub(super) email: String,
}
