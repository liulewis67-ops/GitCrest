use axum::http::Uri;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiSettingsError {
    Invalid,
}

pub fn validate_settings(request: &AiSettingsRequest) -> Result<(), AiSettingsError> {
    if request.base_url.len() > 2048
        || request.model.len() > 255
        || request
            .base_url
            .chars()
            .chain(request.model.chars())
            .any(char::is_control)
        || request.base_url.trim() != request.base_url
        || request.model.trim() != request.model
    {
        return Err(AiSettingsError::Invalid);
    }
    match request.provider {
        AiProvider::None => {
            if !request.base_url.is_empty() || !request.model.is_empty() {
                return Err(AiSettingsError::Invalid);
            }
        }
        AiProvider::OpenAiCompatible => validate_cloud_url(&request.base_url)?,
        AiProvider::Ollama => validate_local_url(&request.base_url)?,
    }
    if request.provider != AiProvider::None && request.model.is_empty() {
        return Err(AiSettingsError::Invalid);
    }
    Ok(())
}

fn parse_endpoint(value: &str) -> Result<Uri, AiSettingsError> {
    if value.is_empty() || value.contains('#') {
        return Err(AiSettingsError::Invalid);
    }
    let uri = value.parse::<Uri>().map_err(|_| AiSettingsError::Invalid)?;
    let authority = uri.authority().ok_or(AiSettingsError::Invalid)?;
    if authority.as_str().contains('@')
        || uri
            .path_and_query()
            .is_some_and(|path| path.query().is_some())
    {
        return Err(AiSettingsError::Invalid);
    }
    Ok(uri)
}

fn validate_cloud_url(value: &str) -> Result<(), AiSettingsError> {
    let uri = parse_endpoint(value)?;
    if uri.scheme_str() != Some("https") {
        return Err(AiSettingsError::Invalid);
    }
    let host = uri.host().ok_or(AiSettingsError::Invalid)?;
    if host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
    {
        return Err(AiSettingsError::Invalid);
    }
    Ok(())
}

fn validate_local_url(value: &str) -> Result<(), AiSettingsError> {
    let uri = parse_endpoint(value)?;
    if uri.scheme_str() != Some("http") {
        return Err(AiSettingsError::Invalid);
    }
    let host = uri.host().ok_or(AiSettingsError::Invalid)?;
    if !host.eq_ignore_ascii_case("localhost")
        && !host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
    {
        return Err(AiSettingsError::Invalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_keep_cloud_and_local_endpoint_boundaries_distinct() {
        let cloud = AiSettingsRequest {
            provider: AiProvider::OpenAiCompatible,
            base_url: "https://api.example.test/v1".into(),
            model: "model-a".into(),
        };
        assert_eq!(validate_settings(&cloud), Ok(()));

        for base_url in [
            "http://api.example.test/v1",
            "https://localhost/v1",
            "https://127.0.0.1/v1",
            "https://user:secret@example.test/v1",
            "https://api.example.test/v1?token=secret",
        ] {
            let request = AiSettingsRequest {
                base_url: base_url.into(),
                ..cloud.clone()
            };
            assert_eq!(validate_settings(&request), Err(AiSettingsError::Invalid));
        }

        for base_url in [
            "http://localhost:11434",
            "http://127.0.0.1:11434",
            "http://[::1]:11434",
        ] {
            assert_eq!(
                validate_settings(&AiSettingsRequest {
                    provider: AiProvider::Ollama,
                    base_url: base_url.into(),
                    model: "qwen".into(),
                }),
                Ok(())
            );
        }
        for base_url in ["https://localhost:11434", "http://192.168.1.3:11434"] {
            assert_eq!(
                validate_settings(&AiSettingsRequest {
                    provider: AiProvider::Ollama,
                    base_url: base_url.into(),
                    model: "qwen".into(),
                }),
                Err(AiSettingsError::Invalid)
            );
        }
    }
}
