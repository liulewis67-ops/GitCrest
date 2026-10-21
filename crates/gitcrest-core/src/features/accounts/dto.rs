use serde::Deserialize;

use crate::domain::account::HostingProvider;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TokenSignInRequest {
    pub(super) provider: HostingProvider,
    pub(super) host: String,
    pub(super) token: zeroize::Zeroizing<String>,
}
