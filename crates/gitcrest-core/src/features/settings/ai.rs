use std::{collections::HashSet, net::IpAddr, time::Duration};

use super::dto::{AiProviderView, AiRequest};
use crate::domain::{
    ai::{AiApiFormat, AiProviderConfig, AiProviderRecord},
    diff::{DiffDocument, DiffRowKind, DiffRowSide, DiffScope, DiffSelection},
};

pub const MAX_REQUEST_FILES: usize = 20;
pub const MAX_REQUEST_DIFF_BYTES: usize = 1024 * 1024;
pub const MAX_REQUEST_PROMPT_BYTES: usize = 2048;
pub const MAX_PROVIDERS: usize = 20;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROVIDER_ERROR_CHARS: usize = 300;
/// Anthropic Messages requires `max_tokens`; this is used when the provider sets none.
pub const DEFAULT_ANTHROPIC_MAX_TOKENS: u32 = 4096;
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AiRequestError {
    Invalid,
    /// The provider could not be reached or did not answer usably; the detail is safe to show.
    ProviderUnavailable(String),
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
        let scope: DiffScope = file.scope.into();
        if file.path.is_empty()
            || file.path.len() > 4096
            || file.path.chars().any(char::is_control)
            || file.revision.is_empty()
            || !matches!(scope, DiffScope::Index | DiffScope::WorkingTree)
            || !selected.insert((file.path.as_str(), scope))
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
    // Rows in diff order, each with the half that was selected (`None`: the whole row).
    let mut selected = std::collections::BTreeMap::<(usize, usize), Option<DiffRowSide>>::new();
    for selection in selections {
        let hunk = document
            .hunks
            .get(selection.hunk_index)
            .ok_or(AiRequestError::Invalid)?;
        if selection.side.is_some() && selection.row_index.is_none() {
            return Err(AiRequestError::Invalid);
        }
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
            match selected.entry((selection.hunk_index, row_index)) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(selection.side);
                }
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    match (*entry.get(), selection.side) {
                        (Some(first), Some(second)) if first != second => {
                            entry.insert(None);
                        }
                        _ => return Err(AiRequestError::Invalid),
                    }
                }
            }
        }
    }
    let mut output = String::new();
    for hunk_index in 0..document.hunks.len() {
        let hunk = &document.hunks[hunk_index];
        let selected_rows = selected
            .iter()
            .filter(|((index, _), _)| *index == hunk_index)
            .map(|((_, row), side)| (*row, *side))
            .collect::<Vec<_>>();
        if selected_rows.is_empty() {
            continue;
        }
        output.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
        ));
        for (row_index, side) in selected_rows {
            let row = &hunk.rows[row_index];
            if let Some(text) = row
                .old_text
                .as_ref()
                .filter(|_| side != Some(DiffRowSide::New))
            {
                output.push('-');
                output.push_str(text);
                output.push('\n');
            }
            if let Some(text) = row
                .new_text
                .as_ref()
                .filter(|_| side != Some(DiffRowSide::Old))
            {
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

fn endpoint(provider: &AiProviderRecord) -> String {
    let base = provider.base_url.trim_end_matches('/');
    match provider.api_format {
        AiApiFormat::OpenAiChatCompletions => format!("{base}/chat/completions"),
        AiApiFormat::OpenAiResponses => format!("{base}/responses"),
        AiApiFormat::AnthropicMessages => format!("{base}/messages"),
    }
}

fn payload(provider: &AiProviderRecord, prompt: &str) -> serde_json::Value {
    let mut payload = match provider.api_format {
        AiApiFormat::OpenAiChatCompletions => serde_json::json!({
            "model": provider.model,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": false
        }),
        AiApiFormat::OpenAiResponses => serde_json::json!({
            "model": provider.model,
            "input": prompt,
            "store": false
        }),
        AiApiFormat::AnthropicMessages => serde_json::json!({
            "model": provider.model,
            "max_tokens": provider.max_output_tokens.unwrap_or(DEFAULT_ANTHROPIC_MAX_TOKENS),
            "messages": [{ "role": "user", "content": prompt }]
        }),
    };
    if let Some(limit) = provider.max_output_tokens {
        match provider.api_format {
            AiApiFormat::OpenAiChatCompletions => payload["max_tokens"] = limit.into(),
            AiApiFormat::OpenAiResponses => payload["max_output_tokens"] = limit.into(),
            AiApiFormat::AnthropicMessages => {}
        }
    }
    payload
}

/// Joins the text parts of a provider reply, or `None` when it carries no text.
fn reply_text(format: AiApiFormat, response: &serde_json::Value) -> Option<String> {
    fn joined<'a>(parts: impl Iterator<Item = &'a serde_json::Value>, kind: &str) -> String {
        parts
            .filter(|part| part["type"] == kind)
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("")
    }
    let text = match format {
        AiApiFormat::OpenAiChatCompletions => {
            let content = response.pointer("/choices/0/message/content")?;
            match content {
                serde_json::Value::String(text) => text.clone(),
                serde_json::Value::Array(parts) => joined(parts.iter(), "text"),
                _ => return None,
            }
        }
        AiApiFormat::OpenAiResponses => match response["output_text"].as_str() {
            Some(text) => text.to_owned(),
            None => joined(
                response["output"]
                    .as_array()?
                    .iter()
                    .filter(|item| item["type"] == "message")
                    .filter_map(|item| item["content"].as_array())
                    .flatten(),
                "output_text",
            ),
        },
        AiApiFormat::AnthropicMessages => joined(response["content"].as_array()?.iter(), "text"),
    };
    (!text.trim().is_empty()).then_some(text)
}

/// A short, single-line description of a failed provider answer that never repeats the key.
fn provider_error_detail(status: u16, body: &[u8], api_key: Option<&str>) -> String {
    let message = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("error").filter(|error| error.is_string()))
                .or_else(|| value.get("message"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| String::from_utf8_lossy(body).into_owned());
    let mut message = message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    if let Some(key) = api_key.filter(|key| key.len() >= 4) {
        message = message.replace(key, "***");
    }
    let message = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let message = if message.chars().count() > MAX_PROVIDER_ERROR_CHARS {
        format!(
            "{}…",
            message
                .chars()
                .take(MAX_PROVIDER_ERROR_CHARS)
                .collect::<String>()
        )
    } else {
        message
    };
    if message.is_empty() {
        format!("The provider answered HTTP {status}.")
    } else {
        format!("The provider answered HTTP {status}: {message}")
    }
}

pub async fn request_provider(
    provider: &AiProviderRecord,
    prompt: &str,
) -> Result<String, AiRequestError> {
    validate_provider(provider).map_err(|_| AiRequestError::Invalid)?;
    let api_key = provider
        .api_key
        .as_deref()
        .map(String::as_str)
        .filter(|key| !key.is_empty());
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none());
    if is_local_endpoint(&provider.base_url) {
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|_| {
        AiRequestError::ProviderUnavailable("The HTTP client could not start.".into())
    })?;
    let mut request = client
        .post(endpoint(provider))
        .json(&payload(provider, prompt));
    request = match (provider.api_format, api_key) {
        (AiApiFormat::AnthropicMessages, key) => {
            let request = request.header("anthropic-version", ANTHROPIC_VERSION);
            match key {
                Some(key) => request.header("x-api-key", key),
                None => request,
            }
        }
        (_, Some(key)) => request.bearer_auth(key),
        (_, None) => request,
    };
    let mut response = request.send().await.map_err(|error| {
        AiRequestError::ProviderUnavailable(if error.is_timeout() {
            "The provider did not answer in time.".into()
        } else if error.is_connect() {
            "The provider endpoint could not be reached.".into()
        } else {
            "The request to the provider failed.".into()
        })
    })?;
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        AiRequestError::ProviderUnavailable("The provider response was interrupted.".into())
    })? {
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err(AiRequestError::ProviderUnavailable(
                "The provider response exceeded 4 MiB.".into(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(AiRequestError::ProviderUnavailable(provider_error_detail(
            status.as_u16(),
            &body,
            api_key,
        )));
    }
    let response: serde_json::Value = serde_json::from_slice(&body).map_err(|_| {
        AiRequestError::ProviderUnavailable(
            "The provider response was not JSON. Check the endpoint and API format.".into(),
        )
    })?;
    reply_text(provider.api_format, &response).ok_or_else(|| {
        AiRequestError::ProviderUnavailable(
            "The provider response had no text. Check the API format and model.".into(),
        )
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiSettingsError(pub String);

fn has_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

pub fn validate_provider(provider: &AiProviderRecord) -> Result<(), AiSettingsError> {
    let label = if provider.name.trim().is_empty() {
        "A provider".to_owned()
    } else {
        format!("Provider \"{}\"", provider.name.trim())
    };
    let invalid = |reason: &str| Err(AiSettingsError(format!("{label} {reason}")));
    if provider.id.is_empty()
        || provider.id.len() > 64
        || !provider
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return invalid("has an invalid id.");
    }
    if provider.name.trim().is_empty()
        || provider.name.chars().count() > 100
        || has_control(&provider.name)
    {
        return invalid("needs a name of up to 100 characters.");
    }
    if provider.model.trim().is_empty()
        || provider.model.len() > 255
        || provider.model.trim() != provider.model
        || has_control(&provider.model)
    {
        return invalid("needs a model name.");
    }
    if provider
        .api_key
        .as_deref()
        .is_some_and(|key| key.len() > 4096 || has_control(key) || key.trim() != key.as_str())
    {
        return invalid("has an API key with spaces or control characters.");
    }
    if provider
        .max_output_tokens
        .is_some_and(|limit| limit == 0 || limit > 1_000_000)
    {
        return invalid("needs a maximum output between 1 and 1000000 tokens.");
    }
    validate_endpoint(&provider.base_url).or_else(invalid)
}

/// `https` anywhere, or plain `http` only to this machine, with no credentials, query or fragment.
fn validate_endpoint(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 2048 || value.trim() != value || has_control(value) {
        return Err("needs a base URL.");
    }
    let url = url::Url::parse(value).map_err(|_| "has a base URL that is not a valid URL.")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("must not put credentials in the base URL.");
    }
    if url.query().is_some() || url.fragment().is_some() || value.contains(['?', '#']) {
        return Err("must not have a query or fragment in the base URL.");
    }
    match url.scheme() {
        "https" if url.host().is_some() => Ok(()),
        "http" if is_local_endpoint(value) => Ok(()),
        "http" => Err("must use https unless the endpoint is on this machine (localhost)."),
        _ => Err("must use an http(s) base URL."),
    }
}

pub fn is_local_endpoint(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(url::Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => false,
    }
}

pub fn validate_config(config: &AiProviderConfig) -> Result<(), AiSettingsError> {
    if config.providers.len() > MAX_PROVIDERS {
        return Err(AiSettingsError(format!(
            "Save at most {MAX_PROVIDERS} providers."
        )));
    }
    let mut ids = HashSet::new();
    for provider in &config.providers {
        validate_provider(provider)?;
        if !ids.insert(provider.id.as_str()) {
            return Err(AiSettingsError("Two providers share one id.".into()));
        }
    }
    if config
        .active_provider_id
        .as_deref()
        .is_some_and(|id| !ids.contains(id))
    {
        return Err(AiSettingsError(
            "The active provider is not in the provider list.".into(),
        ));
    }
    Ok(())
}

pub fn provider_view(provider: &AiProviderRecord) -> AiProviderView {
    AiProviderView {
        id: provider.id.clone(),
        name: provider.name.clone(),
        api_format: provider.api_format,
        base_url: provider.base_url.clone(),
        model: provider.model.clone(),
        max_output_tokens: provider.max_output_tokens,
        has_api_key: provider
            .api_key
            .as_deref()
            .is_some_and(|key| !key.is_empty()),
        is_local: is_local_endpoint(&provider.base_url),
    }
}

/// Models often wrap a whole-file answer in one Markdown fence despite being asked not to; this
/// returns the fenced body, or the text unchanged when it is not exactly one fenced block.
pub fn strip_code_fence(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return text;
    };
    let Some(body) = rest.strip_suffix("```") else {
        return text;
    };
    let Some(newline) = body.find('\n') else {
        return text;
    };
    let body = &body[newline + 1..];
    if body.contains("\n```") {
        return text;
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn provider(api_format: AiApiFormat, base_url: &str) -> AiProviderRecord {
        AiProviderRecord {
            id: "provider-1".into(),
            name: "Test".into(),
            api_format,
            base_url: base_url.into(),
            model: "model-a".into(),
            api_key: Some("secret-key".to_string().into()),
            max_output_tokens: None,
        }
    }

    /// Answers one HTTP request with `status` and `response`, returning the request's headers and body.
    async fn serve_once(
        status: &'static str,
        response: &'static str,
    ) -> (String, tokio::task::JoinHandle<(String, String)>) {
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
            stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
            (
                String::from_utf8_lossy(&request[..header_end]).to_string(),
                body,
            )
        });
        (format!("http://{address}/v1"), capture)
    }

    #[test]
    fn endpoints_allow_https_anywhere_and_http_only_on_this_machine() {
        for base_url in [
            "https://api.openai.com/v1",
            "https://api.anthropic.com/v1",
            "https://localhost:8443/v1",
            "http://localhost:11434/v1",
            "http://127.0.0.1:1234/v1",
            "http://[::1]:8080",
        ] {
            assert_eq!(
                validate_provider(&provider(AiApiFormat::OpenAiChatCompletions, base_url)),
                Ok(()),
                "{base_url}"
            );
        }
        for base_url in [
            "",
            "http://api.example.test/v1",
            "http://192.168.1.3:11434",
            "ftp://api.example.test",
            "https://user:secret@example.test/v1",
            "https://api.example.test/v1?token=secret",
            "https://api.example.test/v1#part",
            " https://api.example.test/v1",
        ] {
            assert!(
                validate_provider(&provider(AiApiFormat::OpenAiChatCompletions, base_url)).is_err(),
                "{base_url}"
            );
        }
        assert!(is_local_endpoint("http://127.0.0.1:11434/v1"));
        assert!(!is_local_endpoint("https://api.openai.com/v1"));
    }

    #[test]
    fn a_single_fence_around_the_whole_answer_is_removed() {
        assert_eq!(
            strip_code_fence("```rust\nfn main() {}\n```\n"),
            "fn main() {}\n"
        );
        assert_eq!(strip_code_fence("```\na\nb\n```"), "a\nb\n");
        assert_eq!(strip_code_fence("plain\ntext\n"), "plain\ntext\n");
        let two_blocks = "```\na\n```\nmiddle\n```\nb\n```";
        assert_eq!(strip_code_fence(two_blocks), two_blocks);
    }

    #[test]
    fn config_rejects_duplicate_ids_and_a_missing_active_provider() {
        let first = provider(AiApiFormat::OpenAiResponses, "https://api.example.test/v1");
        let config = AiProviderConfig {
            version: AiProviderConfig::VERSION,
            active_provider_id: Some("provider-1".into()),
            providers: vec![first.clone()],
        };
        assert_eq!(validate_config(&config), Ok(()));
        assert!(validate_config(&AiProviderConfig {
            providers: vec![first.clone(), first.clone()],
            ..config.clone()
        })
        .is_err());
        assert!(validate_config(&AiProviderConfig {
            active_provider_id: Some("missing".into()),
            ..config
        })
        .is_err());
    }

    #[tokio::test]
    async fn chat_completions_post_to_chat_completions_with_a_bearer_key() {
        let (base_url, capture) = serve_once(
            "200 OK",
            r#"{"choices":[{"message":{"content":"chat reply"}}]}"#,
        )
        .await;
        let reply = request_provider(
            &provider(AiApiFormat::OpenAiChatCompletions, &base_url),
            "only this reviewed diff",
        )
        .await
        .unwrap();
        assert_eq!(reply, "chat reply");
        let (headers, body) = capture.await.unwrap();
        assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("authorization: bearer secret-key"));
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["model"], "model-a");
        assert_eq!(body["messages"][0]["content"], "only this reviewed diff");
        assert_eq!(body["stream"], false);
        assert!(body.get("max_tokens").is_none());
    }

    #[tokio::test]
    async fn responses_post_to_responses_and_join_output_text_parts() {
        let (base_url, capture) = serve_once(
            "200 OK",
            r#"{"output":[{"type":"reasoning","summary":[]},{"type":"message","content":[{"type":"output_text","text":"first "},{"type":"output_text","text":"second"}]}]}"#,
        )
        .await;
        let mut configured = provider(AiApiFormat::OpenAiResponses, &base_url);
        configured.max_output_tokens = Some(900);
        let reply = request_provider(&configured, "summarize").await.unwrap();
        assert_eq!(reply, "first second");
        let (headers, body) = capture.await.unwrap();
        assert!(headers.starts_with("POST /v1/responses HTTP/1.1"));
        assert!(headers
            .to_ascii_lowercase()
            .contains("authorization: bearer secret-key"));
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["input"], "summarize");
        assert_eq!(body["store"], false);
        assert_eq!(body["max_output_tokens"], 900);
    }

    #[tokio::test]
    async fn anthropic_messages_send_the_key_header_version_and_max_tokens() {
        let (base_url, capture) = serve_once(
            "200 OK",
            r#"{"content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"anthropic reply"}]}"#,
        )
        .await;
        let reply = request_provider(
            &provider(AiApiFormat::AnthropicMessages, &base_url),
            "merge this",
        )
        .await
        .unwrap();
        assert_eq!(reply, "anthropic reply");
        let (headers, body) = capture.await.unwrap();
        let headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with("post /v1/messages http/1.1"));
        assert!(headers.contains("x-api-key: secret-key"));
        assert!(headers.contains("anthropic-version: 2023-06-01"));
        assert!(!headers.contains("authorization:"));
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["max_tokens"], DEFAULT_ANTHROPIC_MAX_TOKENS);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "merge this");
    }

    #[tokio::test]
    async fn local_providers_need_no_key_and_send_no_authorization() {
        let (base_url, capture) =
            serve_once("200 OK", r#"{"choices":[{"message":{"content":"local"}}]}"#).await;
        let mut local = provider(AiApiFormat::OpenAiChatCompletions, &base_url);
        local.api_key = None;
        assert_eq!(request_provider(&local, "hi").await.unwrap(), "local");
        let (headers, _) = capture.await.unwrap();
        assert!(!headers.to_ascii_lowercase().contains("authorization:"));
    }

    #[tokio::test]
    async fn provider_errors_name_the_status_and_message_without_the_key() {
        let (base_url, capture) = serve_once(
            "401 Unauthorized",
            r#"{"error":{"message":"Incorrect API key provided: secret-key."}}"#,
        )
        .await;
        let error = request_provider(
            &provider(AiApiFormat::OpenAiChatCompletions, &base_url),
            "hi",
        )
        .await
        .unwrap_err();
        capture.await.unwrap();
        let AiRequestError::ProviderUnavailable(detail) = error else {
            panic!("expected a provider error");
        };
        assert!(detail.contains("HTTP 401"));
        assert!(detail.contains("Incorrect API key provided"));
        assert!(!detail.contains("secret-key"));
    }
}
