use serde::Serialize;

/// The commit signing setup Git resolves for a repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SigningConfig {
    pub repo_id: String,
    /// `openpgp` (GPG), `ssh` or `x509`.
    pub format: String,
    /// `user.signingkey`: a key id, a public key or the path of a key file. Never key material.
    pub signing_key: Option<String>,
    /// `commit.gpgsign`: commits are signed without being asked.
    pub sign_by_default: bool,
    /// The configured signing program, or null when Git's default for the format is used.
    pub program: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SigningTestResult {
    pub repo_id: String,
    /// A signature was made with the configured key.
    pub signed: bool,
    /// What the signing tool said when it failed, shortened; empty on success.
    pub output: String,
}
