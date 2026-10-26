use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// The wire format a configured provider speaks.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AiApiFormat {
    /// `POST {baseUrl}/chat/completions`
    OpenAiChatCompletions,
    /// `POST {baseUrl}/responses`
    OpenAiResponses,
    /// `POST {baseUrl}/messages`
    AnthropicMessages,
}

/// One provider as it is stored in `ai-providers.json`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderRecord {
    pub id: String,
    pub name: String,
    pub api_format: AiApiFormat,
    pub base_url: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<Zeroizing<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
}

/// The whole `ai-providers.json` file. No active provider means AI assistance is off.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    #[serde(default = "AiProviderConfig::current_version")]
    pub version: u32,
    #[serde(default)]
    pub active_provider_id: Option<String>,
    #[serde(default)]
    pub providers: Vec<AiProviderRecord>,
}

impl AiProviderConfig {
    pub const VERSION: u32 = 1;

    fn current_version() -> u32 {
        Self::VERSION
    }

    pub fn active_provider(&self) -> Option<&AiProviderRecord> {
        let id = self.active_provider_id.as_deref()?;
        self.providers.iter().find(|provider| provider.id == id)
    }
}

impl Default for AiProviderConfig {
    fn default() -> Self {
        Self {
            version: Self::VERSION,
            active_provider_id: None,
            providers: Vec::new(),
        }
    }
}
