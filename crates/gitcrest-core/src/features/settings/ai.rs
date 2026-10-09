use axum::http::Uri;
use std::{collections::HashSet, net::IpAddr, time::Duration};

use super::dto::{AiProvider, AiRequest, AiSettingsRequest};
use crate::{
    domain::diff::DiffSelection,
    features::diff::{DiffDocument, DiffRowKind, DiffScope},
};

pub const MAX_REQUEST_FILES: usize = 20;
pub const MAX_REQUEST_DIFF_BYTES: usize = 1024 * 1024;
pub const MAX_REQUEST_PROMPT_BYTES: usize = 2048;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiRequestError {
    Invalid,
    ProviderUnavailable,
}

pub fn validate_request(request: &AiRequest) -> Result<(), AiRequestError> {
    if request.files.is_empty()
        || request.files.len() > MAX_REQUEST_FILES
        || request.prompt.trim().is_empty()
        || request.prompt.len() > MAX_REQUEST_PROMPT_BYTES
        || request
            .prompt
            .chars()
            .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err(AiRequestError::Invalid);
    }
    let mut selected = HashSet::new();
    for file in &request.files {
        if file.path.is_empty()
            || file.path.len() > 4096
            || file.path.chars().any(char::is_control)
            || file.revision.is_empty()
            || !matches!(file.scope, DiffScope::Index | DiffScope::WorkingTree)
            || !selected.insert((file.path.as_str(), file.scope))
            || file.selections.as_ref().is_some_and(|selections| {
                selections.is_empty()
                    || selections.len() > 500
                    || selections
                        .iter()
                        .map(|item| (item.hunk_index, item.row_index))
                        .collect::<HashSet<_>>()
                        .len()
                        != selections.len()
            })
        {
            return Err(AiRequestError::Invalid);
        }
    }
    Ok(())
}

pub fn format_diff(document: &DiffDocument) -> String {
    let mut output = String::new();
    for hunk in &document.hunks {
        output.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
        ));
        for row in &hunk.rows {
            if row.kind == DiffRowKind::Context {
                output.push(' ');
                output.push_str(
                    row.old_text
                        .as_deref()
                        .or(row.new_text.as_deref())
                        .unwrap_or(""),
                );
                output.push('\n');
            } else {
                if let Some(text) = &row.old_text {
                    output.push('-');
                    output.push_str(text);
                    output.push('\n');
                }
                if let Some(text) = &row.new_text {
                    output.push('+');
                    output.push_str(text);
                    output.push('\n');
                }
            }
            if output.len() > MAX_REQUEST_DIFF_BYTES {
                break;
            }
        }
        if output.len() > MAX_REQUEST_DIFF_BYTES {
            break;
        }
    }
    output
}

pub fn format_selected_changes(
    document: &DiffDocument,
    selections: &[DiffSelection],
) -> Result<String, AiRequestError> {
    if selections.is_empty() || selections.len() > 500 {
        return Err(AiRequestError::Invalid);
    }
    let mut selected = HashSet::new();
    for selection in selections {
        let hunk = document
            .hunks
            .get(selection.hunk_index)
            .ok_or(AiRequestError::Invalid)?;
        let rows = match selection.row_index {
            Some(row_index) => {
                let row = hunk.rows.get(row_index).ok_or(AiRequestError::Invalid)?;
                if row.kind != DiffRowKind::Change {
                    return Err(AiRequestError::Invalid);
                }
                vec![row_index]
            }
            None => hunk
                .rows
                .iter()
                .enumerate()
                .filter(|(_, row)| row.kind == DiffRowKind::Change)
                .map(|(index, _)| index)
                .collect(),
        };
        for row_index in rows {
            if !selected.insert((selection.hunk_index, row_index)) {
                return Err(AiRequestError::Invalid);
            }
        }
    }
    let mut output = String::new();
    for hunk_index in 0..document.hunks.len() {
        let hunk = &document.hunks[hunk_index];
        let selected_rows = selected
            .iter()
            .filter(|(index, _)| *index == hunk_index)
            .map(|(_, row)| *row)
            .collect::<Vec<_>>();
        if selected_rows.is_empty() {
            continue;
        }
        output.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
        ));
        for row_index in selected_rows {
            let row = &hunk.rows[row_index];
            if let Some(text) = &row.old_text {
                output.push('-');
                output.push_str(text);
                output.push('\n');
            }
            if let Some(text) = &row.new_text {
                output.push('+');
                output.push_str(text);
                output.push('\n');
            }
            if output.len() > MAX_REQUEST_DIFF_BYTES {
                return Err(AiRequestError::Invalid);
            }
        }
    }
    if output.is_empty() {
        return Err(AiRequestError::Invalid);
    }
    Ok(output)
}

pub async fn request_provider(
    provider: AiProvider,
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    prompt: &str,
) -> Result<String, AiRequestError> {
    if provider == AiProvider::None {
        return Err(AiRequestError::Invalid);
    }
    if provider == AiProvider::OpenAiCompatible && api_key.is_none() {
        return Err(AiRequestError::Invalid);
    }
    let settings = AiSettingsRequest {
        provider,
        base_url: base_url.to_owned(),
        model: model.to_owned(),
    };
    validate_settings(&settings).map_err(|_| AiRequestError::Invalid)?;
    let endpoint = match provider {
        AiProvider::OpenAiCompatible => {
            format!("{}/chat/completions", base_url.trim_end_matches('/'))
        }
        AiProvider::Ollama => format!("{}/api/chat", base_url.trim_end_matches('/')),
        AiProvider::None => return Err(AiRequestError::Invalid),
    };
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    if provider == AiProvider::Ollama {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|_| AiRequestError::ProviderUnavailable)?;
    let payload = match provider {
        AiProvider::OpenAiCompatible => serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": false
        }),
        AiProvider::Ollama => serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": false
        }),
        AiProvider::None => return Err(AiRequestError::Invalid),
    };
    let mut request = client.post(endpoint).json(&payload);
    if let Some(api_key) = api_key {
        request = request.bearer_auth(api_key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| AiRequestError::ProviderUnavailable)?;
    if !response.status().is_success() {
        return Err(AiRequestError::ProviderUnavailable);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AiRequestError::ProviderUnavailable)?
    {
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err(AiRequestError::ProviderUnavailable);
        }
        body.extend_from_slice(&chunk);
    }
    let response: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| AiRequestError::ProviderUnavailable)?;
    let text = match provider {
        AiProvider::OpenAiCompatible => response
            .pointer("/choices/0/message/content")
            .and_then(serde_json::Value::as_str),
        AiProvider::Ollama => response
            .pointer("/message/content")
            .and_then(serde_json::Value::as_str),
        AiProvider::None => None,
    }
    .filter(|text| !text.trim().is_empty())
    .ok_or(AiRequestError::ProviderUnavailable)?;
    Ok(text.to_owned())
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
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

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

    #[tokio::test]
    async fn ollama_requests_use_only_the_configured_loopback_endpoint() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let capture = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            let (header_end, content_length) = loop {
                let read = stream.read(&mut chunk).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&chunk[..read]);
                if let Some(header_end) =
                    request.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap();
                    if request.len() >= header_end + 4 + content_length {
                        break (header_end, content_length);
                    }
                }
            };
            let body_start = header_end + 4;
            let body = String::from_utf8(request[body_start..body_start + content_length].to_vec())
                .unwrap();
            let response = r#"{"message":{"content":"local response"}}"#;
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
            (
                String::from_utf8_lossy(&request[..header_end]).to_string(),
                body,
            )
        });

        let response = request_provider(
            AiProvider::Ollama,
            &format!("http://{address}"),
            "qwen-local",
            None,
            "only this reviewed diff",
        )
        .await
        .unwrap();
        assert_eq!(response, "local response");
        let (headers, body) = capture.await.unwrap();
        assert!(headers.starts_with("POST /api/chat HTTP/1.1"));
        assert!(!headers.to_ascii_lowercase().contains("authorization:"));
        let request: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(request["model"], "qwen-local");
        assert_eq!(request["messages"][0]["content"], "only this reviewed diff");
        assert_eq!(request["stream"], false);
    }
}
