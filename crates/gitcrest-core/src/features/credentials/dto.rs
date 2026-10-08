use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CredentialHostQuery {
    pub(super) host: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SetCredentialRequest {
    pub(super) host: String,
    pub(super) username: String,
    pub(super) token: zeroize::Zeroizing<String>,
}
