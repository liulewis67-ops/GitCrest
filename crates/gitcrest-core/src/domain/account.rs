use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostingProvider {
    Github,
    Gitlab,
}

impl HostingProvider {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitlab => "gitlab",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "github" => Some(Self::Github),
            "gitlab" => Some(Self::Gitlab),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AccountAuthKind {
    /// A personal access token the user pasted.
    Token,
    /// A token from browser sign-in (OAuth device flow), possibly with a refresh token.
    Oauth,
}

impl AccountAuthKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Token => "token",
            Self::Oauth => "oauth",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "token" => Some(Self::Token),
            "oauth" => Some(Self::Oauth),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AccountState {
    Active,
    NeedsReauth,
}

impl AccountState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::NeedsReauth => "needsReauth",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "needsReauth" => Some(Self::NeedsReauth),
            _ => None,
        }
    }
}

/// Account metadata kept in SQLite. The token itself lives only in the system keyring under
/// `account_id`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostingAccount {
    pub(crate) account_id: String,
    pub(crate) provider: HostingProvider,
    pub(crate) host: String,
    pub(crate) api_base_url: String,
    pub(crate) remote_user_id: String,
    pub(crate) login: String,
    pub(crate) display_name: Option<String>,
    pub(crate) avatar_url: Option<String>,
    pub(crate) auth_kind: AccountAuthKind,
    pub(crate) scopes: Vec<String>,
    pub(crate) token_expires_at_ms: Option<i64>,
    pub(crate) state: AccountState,
    pub(crate) created_at_ms: i64,
    pub(crate) last_validated_at_ms: i64,
}
