use serde::{Deserialize, Serialize};

use crate::features::diff::DiffScope;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AiProvider {
    None,
    OpenAiCompatible,
    Ollama,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub provider: AiProvider,
    pub base_url: String,
    pub model: String,
    pub has_cloud_credential: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSettingsRequest {
    pub provider: AiProvider,
    pub base_url: String,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiCredentialRequest {
    pub api_key: zeroize::Zeroizing<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiFileSelection {
    pub path: String,
    pub scope: DiffScope,
    pub revision: String,
    #[serde(default)]
    pub selections: Option<Vec<AiDiffSelection>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiDiffSelection {
    pub hunk_index: usize,
    #[serde(default)]
    pub row_index: Option<usize>,
}

impl From<AiDiffSelection> for crate::domain::diff::DiffSelection {
    fn from(selection: AiDiffSelection) -> Self {
        Self {
            hunk_index: selection.hunk_index,
            row_index: selection.row_index,
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
    pub provider: AiProvider,
    pub model: String,
    pub response: String,
    pub files: Vec<String>,
}
