use serde::{Deserialize, Serialize};

pub use crate::domain::ai::AiApiFormat;

/// A configured provider as the client sees it: the API key itself never leaves the core.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderView {
    pub id: String,
    pub name: String,
    pub api_format: AiApiFormat,
    pub base_url: String,
    pub model: String,
    pub max_output_tokens: Option<u32>,
    pub has_api_key: bool,
    /// The endpoint is a loopback address, so requests stay on this machine.
    pub is_local: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub active_provider_id: Option<String>,
    pub providers: Vec<AiProviderView>,
    pub config_path: Option<String>,
}

/// A provider as Settings saves it. `apiKey` absent or `null` keeps the key already saved for
/// this `id`; an empty string removes it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiProviderInput {
    pub id: String,
    pub name: String,
    pub api_format: AiApiFormat,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    #[serde(default)]
    pub api_key: Option<zeroize::Zeroizing<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSettingsRequest {
    #[serde(default)]
    pub active_provider_id: Option<String>,
    pub providers: Vec<AiProviderInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiProviderTestRequest {
    pub provider: AiProviderInput,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderTestReply {
    pub model: String,
    pub response: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiFileSelection {
    pub path: String,
    pub scope: AiDiffScope,
    pub revision: String,
    #[serde(default)]
    pub selections: Option<Vec<AiDiffSelection>>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiDiffScope {
    WorkingTree,
    Index,
    Commit,
}

impl From<AiDiffScope> for crate::domain::diff::DiffScope {
    fn from(scope: AiDiffScope) -> Self {
        match scope {
            AiDiffScope::WorkingTree => Self::WorkingTree,
            AiDiffScope::Index => Self::Index,
            AiDiffScope::Commit => Self::Commit,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiDiffSelection {
    pub hunk_index: usize,
    #[serde(default)]
    pub row_index: Option<usize>,
    #[serde(default)]
    pub side: Option<crate::domain::diff::DiffRowSide>,
}

impl From<AiDiffSelection> for crate::domain::diff::DiffSelection {
    fn from(selection: AiDiffSelection) -> Self {
        Self {
            hunk_index: selection.hunk_index,
            row_index: selection.row_index,
            side: selection.side,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiRequest {
    pub prompt: String,
    pub files: Vec<AiFileSelection>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReply {
    /// The display name of the provider that answered.
    pub provider: String,
    pub api_format: AiApiFormat,
    pub model: String,
    pub response: String,
    pub files: Vec<String>,
}
