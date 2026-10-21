use std::{future::Future, pin::Pin, time::Duration};

use reqwest::{header, StatusCode};

use crate::domain::account::HostingProvider;

const MAX_PROFILE_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_PROFILE_FIELD_CHARS: usize = 255;
const MAX_AVATAR_URL_BYTES: usize = 2048;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostingProfile {
    pub(crate) remote_user_id: String,
    pub(crate) login: String,
    pub(crate) display_name: Option<String>,
    pub(crate) avatar_url: Option<String>,
    /// `None` when the provider does not report scopes for this kind of token.
    pub(crate) scopes: Option<Vec<String>>,
    pub(crate) token_expires_at_ms: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProfileError {
    TokenRejected,
    ProviderUnreachable,
}

pub(crate) type ProfileFuture<'a> =
    Pin<Box<dyn Future<Output = Result<HostingProfile, ProfileError>> + Send + 'a>>;

pub(crate) trait HostingProfileClient: Send + Sync {
    fn fetch_profile<'a>(
        &'a self,
        provider: HostingProvider,
        api_base_url: &'a str,
        token: &'a str,
    ) -> ProfileFuture<'a>;
}

/// The REST API root for a provider on a normalized host. GitHub.com serves its API from a separate
/// host; GitHub Enterprise Server and GitLab serve it under a path on the same host.
pub(crate) fn api_base_url(provider: HostingProvider, host: &str) -> String {
    match provider {
        HostingProvider::Github if host == "github.com" => "https://api.github.com".into(),
        HostingProvider::Github => format!("https://{host}/api/v3"),
        HostingProvider::Gitlab => format!("https://{host}/api/v4"),
    }
}

pub(crate) struct HttpHostingProfileClient;

impl HostingProfileClient for HttpHostingProfileClient {
    fn fetch_profile<'a>(
        &'a self,
        provider: HostingProvider,
        api_base_url: &'a str,
        token: &'a str,
    ) -> ProfileFuture<'a> {
        Box::pin(fetch_profile(provider, api_base_url, token))
    }
}

pub(crate) async fn fetch_profile(
    provider: HostingProvider,
    api_base_url: &str,
    token: &str,
) -> Result<HostingProfile, ProfileError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("GitCrest/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| ProfileError::ProviderUnreachable)?;
    let base = api_base_url.trim_end_matches('/');
    match provider {
        HostingProvider::Github => {
            let (headers, body) = get_json(
                client
                    .get(format!("{base}/user"))
                    .bearer_auth(token)
                    .header(header::ACCEPT, "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28"),
            )
            .await?;
            let mut profile = parse_profile(&body, "login")?;
            profile.scopes = headers
                .get("x-oauth-scopes")
                .and_then(|value| value.to_str().ok())
                .map(parse_scope_list);
            profile.token_expires_at_ms = headers
                .get("github-authentication-token-expiration")
                .and_then(|value| value.to_str().ok())
                .and_then(parse_github_expiration);
            Ok(profile)
        }
        HostingProvider::Gitlab => {
            let (_, body) = get_json(client.get(format!("{base}/user")).bearer_auth(token)).await?;
            let mut profile = parse_profile(&body, "username")?;
            // Only personal, project and group access tokens can describe themselves; OAuth tokens
            // and older GitLab versions answer with an error, which leaves scopes unknown.
            if let Ok((_, token_details)) = get_json(
                client
                    .get(format!("{base}/personal_access_tokens/self"))
                    .bearer_auth(token),
            )
            .await
            {
                profile.scopes = token_details
                    .get("scopes")
                    .and_then(serde_json::Value::as_array)
                    .map(|scopes| {
                        scopes
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .filter(|scope| is_safe_scope(scope))
                            .map(str::to_owned)
                            .collect()
                    });
                profile.token_expires_at_ms = token_details
                    .get("expires_at")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|date| parse_utc_timestamp_ms(date, "00:00:00"));
            }
            Ok(profile)
        }
    }
}

async fn get_json(
    request: reqwest::RequestBuilder,
) -> Result<(header::HeaderMap, serde_json::Value), ProfileError> {
    let mut response = request
        .send()
        .await
        .map_err(|_| ProfileError::ProviderUnreachable)?;
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err(ProfileError::TokenRejected)
        }
        status if !status.is_success() => return Err(ProfileError::ProviderUnreachable),
        _ => {}
    }
    let headers = response.headers().clone();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ProfileError::ProviderUnreachable)?
    {
        if body.len().saturating_add(chunk.len()) > MAX_PROFILE_RESPONSE_BYTES {
            return Err(ProfileError::ProviderUnreachable);
        }
        body.extend_from_slice(&chunk);
    }
    let body = serde_json::from_slice(&body).map_err(|_| ProfileError::ProviderUnreachable)?;
    Ok((headers, body))
}

fn parse_profile(
    body: &serde_json::Value,
    login_field: &str,
) -> Result<HostingProfile, ProfileError> {
    let remote_user_id = body
        .get("id")
        .and_then(serde_json::Value::as_u64)
        .ok_or(ProfileError::ProviderUnreachable)?
        .to_string();
    let login = body
        .get(login_field)
        .and_then(serde_json::Value::as_str)
        .filter(|login| is_safe_text(login))
        .ok_or(ProfileError::ProviderUnreachable)?
        .to_owned();
    let display_name = body
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| is_safe_text(name))
        .map(str::to_owned);
    let avatar_url = body
        .get("avatar_url")
        .and_then(serde_json::Value::as_str)
        .filter(|url| {
            url.starts_with("https://")
                && url.len() <= MAX_AVATAR_URL_BYTES
                && !url
                    .chars()
                    .any(|character| character.is_control() || character == '"')
        })
        .map(str::to_owned);
    Ok(HostingProfile {
        remote_user_id,
        login,
        display_name,
        avatar_url,
        scopes: None,
        token_expires_at_ms: None,
    })
}

fn is_safe_text(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_PROFILE_FIELD_CHARS
        && !value.chars().any(char::is_control)
}

fn is_safe_scope(scope: &str) -> bool {
    !scope.is_empty()
        && scope.len() <= 64
        && scope
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
}

fn parse_scope_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|scope| is_safe_scope(scope))
        .map(str::to_owned)
        .collect()
}

/// GitHub reports token expiry as `YYYY-MM-DD HH:MM:SS UTC` or with a numeric offset such as
/// `-0700`.
fn parse_github_expiration(value: &str) -> Option<i64> {
    let (date, rest) = value.trim().split_once(' ')?;
    let (time, zone) = rest.split_once(' ').unwrap_or((rest, "UTC"));
    let utc = parse_utc_timestamp_ms(date, time)?;
    if zone == "UTC" || zone == "Z" {
        return Some(utc);
    }
    let (sign, digits) = match zone.as_bytes().first()? {
        b'+' => (1, &zone[1..]),
        b'-' => (-1, &zone[1..]),
        _ => return None,
    };
    if digits.len() != 4 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let hours: i64 = digits[..2].parse().ok()?;
    let minutes: i64 = digits[2..].parse().ok()?;
    Some(utc - sign * (hours * 60 + minutes) * 60_000)
}

fn parse_utc_timestamp_ms(date: &str, time: &str) -> Option<i64> {
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 = time_parts.next()?.parse().ok()?;
    if date_parts.next().is_some()
        || time_parts.next().is_some()
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..24).contains(&hour)
        || !(0..60).contains(&minute)
        || !(0..61).contains(&second)
    {
        return None;
    }
    // Days from 1970-01-01 in the proleptic Gregorian calendar (Howard Hinnant's algorithm).
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::{HeaderMap, StatusCode as AxumStatus},
        response::IntoResponse,
        routing::get,
        Json, Router,
    };

    async fn serve(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        format!("http://{address}")
    }

    fn bearer(headers: &HeaderMap) -> Option<&str> {
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
    }

    #[test]
    fn builds_api_roots_for_hosted_and_self_managed_instances() {
        assert_eq!(
            api_base_url(HostingProvider::Github, "github.com"),
            "https://api.github.com"
        );
        assert_eq!(
            api_base_url(HostingProvider::Github, "github.example.com:8443"),
            "https://github.example.com:8443/api/v3"
        );
        assert_eq!(
            api_base_url(HostingProvider::Gitlab, "gitlab.com"),
            "https://gitlab.com/api/v4"
        );
    }

    #[test]
    fn parses_provider_expiry_formats() {
        assert_eq!(
            parse_github_expiration("2026-01-02 03:04:05 UTC"),
            Some(1_767_323_045_000)
        );
        assert_eq!(
            parse_github_expiration("2026-01-02 03:04:05 -0100"),
            Some(1_767_323_045_000 + 3_600_000)
        );
        assert_eq!(parse_utc_timestamp_ms("1970-01-01", "00:00:00"), Some(0));
        assert_eq!(
            parse_utc_timestamp_ms("2024-02-29", "00:00:00"),
            Some(1_709_164_800_000)
        );
        assert_eq!(parse_github_expiration("soon"), None);
        assert_eq!(parse_utc_timestamp_ms("2026-13-01", "00:00:00"), None);
    }

    #[tokio::test]
    async fn reads_a_github_profile_with_scopes_and_expiry() {
        let base = serve(Router::new().route(
            "/user",
            get(|headers: HeaderMap| async move {
                if bearer(&headers) != Some("good-token") {
                    return AxumStatus::UNAUTHORIZED.into_response();
                }
                (
                    [
                        ("x-oauth-scopes", "repo, read:user"),
                        (
                            "github-authentication-token-expiration",
                            "2026-01-02 03:04:05 UTC",
                        ),
                    ],
                    Json(serde_json::json!({
                        "id": 583231,
                        "login": "octocat",
                        "name": "The Octocat",
                        "avatar_url": "https://avatars.githubusercontent.com/u/583231?v=4"
                    })),
                )
                    .into_response()
            }),
        ))
        .await;

        let profile = fetch_profile(HostingProvider::Github, &base, "good-token")
            .await
            .unwrap();
        assert_eq!(
            profile,
            HostingProfile {
                remote_user_id: "583231".into(),
                login: "octocat".into(),
                display_name: Some("The Octocat".into()),
                avatar_url: Some("https://avatars.githubusercontent.com/u/583231?v=4".into()),
                scopes: Some(vec!["repo".into(), "read:user".into()]),
                token_expires_at_ms: Some(1_767_323_045_000),
            }
        );
        assert_eq!(
            fetch_profile(HostingProvider::Github, &base, "bad-token").await,
            Err(ProfileError::TokenRejected)
        );
    }

    #[tokio::test]
    async fn reads_a_gitlab_profile_and_tolerates_missing_token_details() {
        let base = serve(
            Router::new()
                .route(
                    "/user",
                    get(|headers: HeaderMap| async move {
                        if bearer(&headers).is_none() {
                            return AxumStatus::UNAUTHORIZED.into_response();
                        }
                        Json(serde_json::json!({
                            "id": 42,
                            "username": "tanuki",
                            "name": "",
                            "avatar_url": "http://insecure.example/avatar.png"
                        }))
                        .into_response()
                    }),
                )
                .route(
                    "/personal_access_tokens/self",
                    get(|headers: HeaderMap| async move {
                        if bearer(&headers) != Some("pat") {
                            return AxumStatus::UNAUTHORIZED.into_response();
                        }
                        Json(serde_json::json!({
                            "scopes": ["read_user", "write_repository", "bad scope"],
                            "expires_at": "2026-01-02"
                        }))
                        .into_response()
                    }),
                ),
        )
        .await;

        let profile = fetch_profile(HostingProvider::Gitlab, &base, "pat")
            .await
            .unwrap();
        assert_eq!(profile.login, "tanuki");
        assert_eq!(profile.remote_user_id, "42");
        assert_eq!(profile.display_name, None);
        assert_eq!(profile.avatar_url, None);
        assert_eq!(
            profile.scopes,
            Some(vec!["read_user".into(), "write_repository".into()])
        );
        assert_eq!(profile.token_expires_at_ms, Some(1_767_312_000_000));

        let oauth_profile = fetch_profile(HostingProvider::Gitlab, &base, "oauth")
            .await
            .unwrap();
        assert_eq!(oauth_profile.scopes, None);
        assert_eq!(oauth_profile.token_expires_at_ms, None);
    }

    #[tokio::test]
    async fn reports_an_unreachable_provider_for_server_errors_and_bad_payloads() {
        let base =
            serve(Router::new().route("/user", get(|| async { AxumStatus::BAD_GATEWAY }))).await;
        assert_eq!(
            fetch_profile(HostingProvider::Github, &base, "token").await,
            Err(ProfileError::ProviderUnreachable)
        );
        let base = serve(Router::new().route(
            "/user",
            get(|| async { Json(serde_json::json!({ "login": "no-id" })) }),
        ))
        .await;
        assert_eq!(
            fetch_profile(HostingProvider::Github, &base, "token").await,
            Err(ProfileError::ProviderUnreachable)
        );
    }
}
