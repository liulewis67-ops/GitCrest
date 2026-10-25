use std::{future::Future, pin::Pin, time::Duration};

use reqwest::{header, StatusCode};
use zeroize::Zeroizing;

use crate::domain::account::HostingProvider;

const MAX_PROFILE_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_PROFILE_FIELD_CHARS: usize = 255;
const MAX_AVATAR_URL_BYTES: usize = 2048;
const MAX_OAUTH_TOKEN_BYTES: usize = 64 * 1024;
const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// RFC 8628 defaults when the provider leaves them out.
const DEFAULT_DEVICE_CODE_LIFETIME: Duration = Duration::from_secs(900);
const DEFAULT_DEVICE_POLL_INTERVAL: Duration = Duration::from_secs(5);
const MAX_DEVICE_CODE_LIFETIME: Duration = Duration::from_secs(30 * 60);
const MAX_DEVICE_POLL_INTERVAL: Duration = Duration::from_secs(60);

/// Public client IDs of the OAuth applications GitCrest signs in with. A release build sets them
/// at compile time; the same variables at run time override them for development. No client
/// secret is ever embedded.
const GITHUB_CLIENT_ID_ENV: &str = "GITCREST_GITHUB_OAUTH_CLIENT_ID";
const GITLAB_CLIENT_ID_ENV: &str = "GITCREST_GITLAB_OAUTH_CLIENT_ID";
const BUILT_IN_GITHUB_CLIENT_ID: Option<&str> = option_env!("GITCREST_GITHUB_OAUTH_CLIENT_ID");
const BUILT_IN_GITLAB_CLIENT_ID: Option<&str> = option_env!("GITCREST_GITLAB_OAUTH_CLIENT_ID");

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

/// What the user needs to approve a device sign-in in the browser.
pub(crate) struct DeviceAuthorization {
    pub(crate) device_code: Zeroizing<String>,
    pub(crate) user_code: String,
    pub(crate) verification_uri: String,
    /// The verification page with the user code already filled in, when the provider offers one.
    pub(crate) verification_uri_complete: Option<String>,
    pub(crate) expires_in: Duration,
    pub(crate) interval: Duration,
}

pub(crate) struct OAuthTokens {
    pub(crate) access_token: Zeroizing<String>,
    pub(crate) refresh_token: Option<Zeroizing<String>>,
    /// `None` for tokens that do not expire, such as GitHub OAuth App tokens.
    pub(crate) expires_in: Option<Duration>,
    pub(crate) scopes: Option<Vec<String>>,
}

pub(crate) enum DevicePoll {
    Pending,
    SlowDown,
    Granted(OAuthTokens),
    Denied,
    Expired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OAuthError {
    /// The provider refused the request: an unknown or disabled client, or a revoked or expired
    /// refresh token.
    Rejected,
    ProviderUnreachable,
}

pub(crate) type ProviderFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub(crate) type ProfileFuture<'a> = ProviderFuture<'a, Result<HostingProfile, ProfileError>>;

pub(crate) trait HostingProviderClient: Send + Sync {
    fn fetch_profile<'a>(
        &'a self,
        provider: HostingProvider,
        api_base_url: &'a str,
        token: &'a str,
    ) -> ProfileFuture<'a>;

    fn start_device_flow<'a>(
        &'a self,
        _provider: HostingProvider,
        _oauth_base_url: &'a str,
        _client_id: &'a str,
    ) -> ProviderFuture<'a, Result<DeviceAuthorization, OAuthError>> {
        Box::pin(async { Err(OAuthError::Rejected) })
    }

    fn poll_device_flow<'a>(
        &'a self,
        _provider: HostingProvider,
        _oauth_base_url: &'a str,
        _client_id: &'a str,
        _device_code: &'a str,
    ) -> ProviderFuture<'a, Result<DevicePoll, OAuthError>> {
        Box::pin(async { Err(OAuthError::Rejected) })
    }

    fn refresh_token<'a>(
        &'a self,
        _provider: HostingProvider,
        _oauth_base_url: &'a str,
        _client_id: &'a str,
        _refresh_token: &'a str,
    ) -> ProviderFuture<'a, Result<OAuthTokens, OAuthError>> {
        Box::pin(async { Err(OAuthError::Rejected) })
    }

    /// Best effort: revokes an OAuth token where the provider allows it without a client secret.
    fn revoke_token<'a>(
        &'a self,
        _provider: HostingProvider,
        _oauth_base_url: &'a str,
        _client_id: &'a str,
        _token: &'a str,
    ) -> ProviderFuture<'a, ()> {
        Box::pin(async {})
    }
}

/// The OAuth applications browser sign-in can use, by provider. Only GitHub.com and GitLab.com
/// have one; Enterprise and self-managed hosts sign in with an access token.
#[derive(Clone, Debug, Default)]
pub(crate) struct OAuthApps {
    github: Option<String>,
    gitlab: Option<String>,
}

impl OAuthApps {
    pub(crate) fn from_environment() -> Self {
        let pick = |variable: &str, built_in: Option<&str>| {
            std::env::var(variable)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| built_in.map(str::to_owned))
                .map(|value| value.trim().to_owned())
                .filter(|value| is_valid_client_id(value))
        };
        Self {
            github: pick(GITHUB_CLIENT_ID_ENV, BUILT_IN_GITHUB_CLIENT_ID),
            gitlab: pick(GITLAB_CLIENT_ID_ENV, BUILT_IN_GITLAB_CLIENT_ID),
        }
    }

    #[cfg(test)]
    pub(crate) fn new(github: Option<&str>, gitlab: Option<&str>) -> Self {
        Self {
            github: github.map(str::to_owned),
            gitlab: gitlab.map(str::to_owned),
        }
    }

    pub(crate) fn client_id(&self, provider: HostingProvider, host: &str) -> Option<&str> {
        match provider {
            HostingProvider::Github if host == "github.com" => self.github.as_deref(),
            HostingProvider::Gitlab if host == "gitlab.com" => self.gitlab.as_deref(),
            _ => None,
        }
    }

    /// `(provider, host)` pairs where browser sign-in is available.
    pub(crate) fn browser_sign_in_hosts(&self) -> Vec<(HostingProvider, &'static str)> {
        let mut hosts = Vec::new();
        if self.github.is_some() {
            hosts.push((HostingProvider::Github, "github.com"));
        }
        if self.gitlab.is_some() {
            hosts.push((HostingProvider::Gitlab, "gitlab.com"));
        }
        hosts
    }
}

fn is_valid_client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

/// Scopes requested at browser sign-in. GitHub needs `workflow` to push changes under
/// `.github/workflows`.
pub(crate) fn oauth_scopes(provider: HostingProvider) -> &'static str {
    match provider {
        HostingProvider::Github => "repo read:user workflow",
        HostingProvider::Gitlab => "read_user read_repository write_repository",
    }
}

/// The web origin that serves a provider's OAuth endpoints on a normalized host.
pub(crate) fn oauth_base_url(host: &str) -> String {
    format!("https://{host}")
}

/// The HTTPS username Git sends with an OAuth access token.
pub(crate) fn oauth_git_username(provider: HostingProvider, login: &str) -> String {
    match provider {
        HostingProvider::Github => login.to_owned(),
        HostingProvider::Gitlab => "oauth2".to_owned(),
    }
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

pub(crate) struct HttpHostingProviderClient;

impl HostingProviderClient for HttpHostingProviderClient {
    fn fetch_profile<'a>(
        &'a self,
        provider: HostingProvider,
        api_base_url: &'a str,
        token: &'a str,
    ) -> ProfileFuture<'a> {
        Box::pin(fetch_profile(provider, api_base_url, token))
    }

    fn start_device_flow<'a>(
        &'a self,
        provider: HostingProvider,
        oauth_base_url: &'a str,
        client_id: &'a str,
    ) -> ProviderFuture<'a, Result<DeviceAuthorization, OAuthError>> {
        Box::pin(start_device_flow(provider, oauth_base_url, client_id))
    }

    fn poll_device_flow<'a>(
        &'a self,
        provider: HostingProvider,
        oauth_base_url: &'a str,
        client_id: &'a str,
        device_code: &'a str,
    ) -> ProviderFuture<'a, Result<DevicePoll, OAuthError>> {
        Box::pin(poll_device_flow(
            provider,
            oauth_base_url,
            client_id,
            device_code,
        ))
    }

    fn refresh_token<'a>(
        &'a self,
        provider: HostingProvider,
        oauth_base_url: &'a str,
        client_id: &'a str,
        refresh_token: &'a str,
    ) -> ProviderFuture<'a, Result<OAuthTokens, OAuthError>> {
        Box::pin(self::refresh_token(
            provider,
            oauth_base_url,
            client_id,
            refresh_token,
        ))
    }

    fn revoke_token<'a>(
        &'a self,
        provider: HostingProvider,
        oauth_base_url: &'a str,
        client_id: &'a str,
        token: &'a str,
    ) -> ProviderFuture<'a, ()> {
        Box::pin(revoke_token(provider, oauth_base_url, client_id, token))
    }
}

fn http_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("GitCrest/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()
}

fn device_code_path(provider: HostingProvider) -> &'static str {
    match provider {
        HostingProvider::Github => "/login/device/code",
        HostingProvider::Gitlab => "/oauth/authorize_device",
    }
}

fn token_path(provider: HostingProvider) -> &'static str {
    match provider {
        HostingProvider::Github => "/login/oauth/access_token",
        HostingProvider::Gitlab => "/oauth/token",
    }
}

pub(crate) async fn start_device_flow(
    provider: HostingProvider,
    oauth_base_url: &str,
    client_id: &str,
) -> Result<DeviceAuthorization, OAuthError> {
    let (status, body) = post_form(
        oauth_base_url,
        device_code_path(provider),
        &[("client_id", client_id), ("scope", oauth_scopes(provider))],
    )
    .await?;
    if !status.is_success() || body.get("error").is_some() {
        return Err(rejection_for(status));
    }
    let text = |field: &str| {
        body.get(field)
            .and_then(serde_json::Value::as_str)
            .filter(|value| is_safe_text(value) && !value.contains(' '))
            .map(str::to_owned)
    };
    let seconds = |field: &str, default: Duration, max: Duration| {
        body.get(field)
            .and_then(serde_json::Value::as_u64)
            .map_or(default, Duration::from_secs)
            .min(max)
    };
    Ok(DeviceAuthorization {
        device_code: Zeroizing::new(
            body.get("device_code")
                .and_then(serde_json::Value::as_str)
                .filter(|code| is_safe_token(code))
                .ok_or(OAuthError::ProviderUnreachable)?
                .to_owned(),
        ),
        user_code: text("user_code").ok_or(OAuthError::ProviderUnreachable)?,
        verification_uri: text("verification_uri").ok_or(OAuthError::ProviderUnreachable)?,
        verification_uri_complete: text("verification_uri_complete"),
        expires_in: seconds(
            "expires_in",
            DEFAULT_DEVICE_CODE_LIFETIME,
            MAX_DEVICE_CODE_LIFETIME,
        ),
        interval: seconds(
            "interval",
            DEFAULT_DEVICE_POLL_INTERVAL,
            MAX_DEVICE_POLL_INTERVAL,
        ),
    })
}

pub(crate) async fn poll_device_flow(
    provider: HostingProvider,
    oauth_base_url: &str,
    client_id: &str,
    device_code: &str,
) -> Result<DevicePoll, OAuthError> {
    let (status, body) = post_form(
        oauth_base_url,
        token_path(provider),
        &[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", DEVICE_CODE_GRANT),
        ],
    )
    .await?;
    // GitHub answers pending polls with 200 and an `error` field; GitLab uses 400.
    if let Some(error) = body.get("error").and_then(serde_json::Value::as_str) {
        return match error {
            "authorization_pending" => Ok(DevicePoll::Pending),
            "slow_down" => Ok(DevicePoll::SlowDown),
            "access_denied" => Ok(DevicePoll::Denied),
            "expired_token" => Ok(DevicePoll::Expired),
            _ if status.is_server_error() => Err(OAuthError::ProviderUnreachable),
            _ => Err(OAuthError::Rejected),
        };
    }
    if !status.is_success() {
        return Err(rejection_for(status));
    }
    parse_tokens(&body).map(DevicePoll::Granted)
}

pub(crate) async fn refresh_token(
    provider: HostingProvider,
    oauth_base_url: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<OAuthTokens, OAuthError> {
    let (status, body) = post_form(
        oauth_base_url,
        token_path(provider),
        &[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ],
    )
    .await?;
    if !status.is_success() || body.get("error").is_some() {
        return Err(rejection_for(status));
    }
    parse_tokens(&body)
}

/// GitLab revokes a public client's token with its client ID alone. GitHub needs the client
/// secret, so its tokens are revoked from the user's application settings instead.
pub(crate) async fn revoke_token(
    provider: HostingProvider,
    oauth_base_url: &str,
    client_id: &str,
    token: &str,
) {
    if provider == HostingProvider::Gitlab {
        let _ = post_form(
            oauth_base_url,
            "/oauth/revoke",
            &[("client_id", client_id), ("token", token)],
        )
        .await;
    }
}

fn rejection_for(status: StatusCode) -> OAuthError {
    if status.is_client_error() {
        OAuthError::Rejected
    } else {
        OAuthError::ProviderUnreachable
    }
}

async fn post_form(
    oauth_base_url: &str,
    path: &str,
    form: &[(&str, &str)],
) -> Result<(StatusCode, serde_json::Value), OAuthError> {
    let client = http_client().ok_or(OAuthError::ProviderUnreachable)?;
    let response = client
        .post(format!("{}{path}", oauth_base_url.trim_end_matches('/')))
        .header(header::ACCEPT, "application/json")
        .form(form)
        .send()
        .await
        .map_err(|_| OAuthError::ProviderUnreachable)?;
    let status = response.status();
    let body = match read_json(response).await {
        Ok(body) => body,
        // An error page without a JSON body still tells the caller which side failed.
        Err(()) if !status.is_success() => serde_json::Value::Null,
        Err(()) => return Err(OAuthError::ProviderUnreachable),
    };
    Ok((status, body))
}

fn parse_tokens(body: &serde_json::Value) -> Result<OAuthTokens, OAuthError> {
    let token = |field: &str| {
        body.get(field)
            .and_then(serde_json::Value::as_str)
            .filter(|token| is_safe_token(token))
            .map(|token| Zeroizing::new(token.to_owned()))
    };
    Ok(OAuthTokens {
        access_token: token("access_token").ok_or(OAuthError::ProviderUnreachable)?,
        refresh_token: token("refresh_token"),
        expires_in: body
            .get("expires_in")
            .and_then(serde_json::Value::as_u64)
            .map(Duration::from_secs),
        // GitHub joins scopes with commas, GitLab with spaces.
        scopes: body
            .get("scope")
            .and_then(serde_json::Value::as_str)
            .map(|scopes| {
                scopes
                    .split([',', ' '])
                    .filter(|scope| is_safe_scope(scope))
                    .map(str::to_owned)
                    .collect()
            }),
    })
}

fn is_safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OAUTH_TOKEN_BYTES
        && !value
            .chars()
            .any(|character| character.is_control() || character == ' ')
}

pub(crate) async fn fetch_profile(
    provider: HostingProvider,
    api_base_url: &str,
    token: &str,
) -> Result<HostingProfile, ProfileError> {
    let client = http_client().ok_or(ProfileError::ProviderUnreachable)?;
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
    let response = request
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
    let body = read_json(response)
        .await
        .map_err(|_| ProfileError::ProviderUnreachable)?;
    Ok((headers, body))
}

/// Reads a JSON body of at most `MAX_PROFILE_RESPONSE_BYTES`. Token responses pass through here,
/// so the raw bytes are cleared after parsing.
async fn read_json(mut response: reqwest::Response) -> Result<serde_json::Value, ()> {
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if body.len().saturating_add(chunk.len()) > MAX_PROFILE_RESPONSE_BYTES {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| ())
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

    #[test]
    fn offers_browser_sign_in_only_on_the_hosted_instances_with_a_client_id() {
        let apps = OAuthApps::new(Some("Iv1.abc"), None);
        assert_eq!(
            apps.client_id(HostingProvider::Github, "github.com"),
            Some("Iv1.abc")
        );
        assert_eq!(
            apps.client_id(HostingProvider::Github, "github.example.com"),
            None
        );
        assert_eq!(apps.client_id(HostingProvider::Gitlab, "gitlab.com"), None);
        assert_eq!(
            apps.browser_sign_in_hosts(),
            vec![(HostingProvider::Github, "github.com")]
        );
        assert!(!is_valid_client_id("has space"));
        assert_eq!(
            oauth_git_username(HostingProvider::Gitlab, "tanuki"),
            "oauth2"
        );
    }

    /// A GitHub-style device flow: pending, then slow_down, then a token. GitHub answers every
    /// poll with 200.
    #[tokio::test]
    async fn runs_a_github_device_flow() {
        use axum::{routing::post, Form};
        use std::collections::HashMap;
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        let polls = Arc::new(AtomicUsize::new(0));
        let poll_counter = polls.clone();
        let base = serve(
            Router::new()
                .route(
                    "/login/device/code",
                    post(|Form(form): Form<HashMap<String, String>>| async move {
                        assert_eq!(form["client_id"], "client");
                        assert_eq!(form["scope"], "repo read:user workflow");
                        Json(serde_json::json!({
                            "device_code": "device-123",
                            "user_code": "WDJB-MJHT",
                            "verification_uri": "https://github.com/login/device",
                            "expires_in": 899,
                            "interval": 5
                        }))
                    }),
                )
                .route(
                    "/login/oauth/access_token",
                    post(move |Form(form): Form<HashMap<String, String>>| {
                        let polls = poll_counter.clone();
                        async move {
                            assert_eq!(form["device_code"], "device-123");
                            assert_eq!(form["grant_type"], DEVICE_CODE_GRANT);
                            Json(match polls.fetch_add(1, Ordering::SeqCst) {
                                0 => serde_json::json!({ "error": "authorization_pending" }),
                                1 => serde_json::json!({ "error": "slow_down", "interval": 10 }),
                                _ => serde_json::json!({
                                    "access_token": "gho_token",
                                    "token_type": "bearer",
                                    "scope": "repo,read:user,workflow"
                                }),
                            })
                        }
                    }),
                ),
        )
        .await;

        let authorization = start_device_flow(HostingProvider::Github, &base, "client")
            .await
            .unwrap();
        assert_eq!(authorization.device_code.as_str(), "device-123");
        assert_eq!(authorization.user_code, "WDJB-MJHT");
        assert_eq!(
            authorization.verification_uri,
            "https://github.com/login/device"
        );
        assert_eq!(authorization.expires_in, Duration::from_secs(899));
        assert_eq!(authorization.interval, Duration::from_secs(5));

        let poll = || poll_device_flow(HostingProvider::Github, &base, "client", "device-123");
        assert!(matches!(poll().await, Ok(DevicePoll::Pending)));
        assert!(matches!(poll().await, Ok(DevicePoll::SlowDown)));
        let Ok(DevicePoll::Granted(tokens)) = poll().await else {
            panic!("expected a token");
        };
        assert_eq!(tokens.access_token.as_str(), "gho_token");
        assert!(tokens.refresh_token.is_none());
        assert_eq!(tokens.expires_in, None);
        assert_eq!(
            tokens.scopes,
            Some(vec!["repo".into(), "read:user".into(), "workflow".into()])
        );
    }

    /// GitLab answers pending and failed polls with 400, issues expiring tokens with a refresh
    /// token, and rotates the refresh token on every refresh.
    #[tokio::test]
    async fn runs_a_gitlab_device_flow_and_refreshes_its_token() {
        use axum::{routing::post, Form};
        use std::collections::HashMap;

        let base = serve(
            Router::new()
                .route(
                    "/oauth/authorize_device",
                    post(|| async {
                        Json(serde_json::json!({
                            "device_code": "lab-device",
                            "user_code": "0A44L90H",
                            "verification_uri": "https://gitlab.com/oauth/device",
                            "verification_uri_complete": "https://gitlab.com/oauth/device?user_code=0A44L90H"
                        }))
                    }),
                )
                .route(
                    "/oauth/token",
                    post(|Form(form): Form<HashMap<String, String>>| async move {
                        let error = |code: &str| {
                            (AxumStatus::BAD_REQUEST, Json(serde_json::json!({ "error": code })))
                                .into_response()
                        };
                        match (form["grant_type"].as_str(), form.get("device_code"), form.get("refresh_token")) {
                            (DEVICE_CODE_GRANT, Some(code), _) if code == "lab-device" => {
                                error("authorization_pending")
                            }
                            (DEVICE_CODE_GRANT, Some(code), _) if code == "denied" => {
                                error("access_denied")
                            }
                            (DEVICE_CODE_GRANT, Some(code), _) if code == "old" => {
                                error("expired_token")
                            }
                            ("refresh_token", _, Some(token)) if token == "refresh-1" => Json(serde_json::json!({
                                "access_token": "access-2",
                                "refresh_token": "refresh-2",
                                "expires_in": 7200,
                                "scope": "read_user read_repository write_repository"
                            }))
                            .into_response(),
                            ("refresh_token", _, _) => error("invalid_grant"),
                            _ => error("invalid_client"),
                        }
                    }),
                ),
        )
        .await;

        let authorization = start_device_flow(HostingProvider::Gitlab, &base, "lab-client")
            .await
            .unwrap();
        assert_eq!(
            authorization.verification_uri_complete.as_deref(),
            Some("https://gitlab.com/oauth/device?user_code=0A44L90H")
        );
        assert_eq!(authorization.expires_in, DEFAULT_DEVICE_CODE_LIFETIME);
        assert_eq!(authorization.interval, DEFAULT_DEVICE_POLL_INTERVAL);

        let poll = |code: &'static str| {
            let base = base.clone();
            async move { poll_device_flow(HostingProvider::Gitlab, &base, "lab-client", code).await }
        };
        assert!(matches!(poll("lab-device").await, Ok(DevicePoll::Pending)));
        assert!(matches!(poll("denied").await, Ok(DevicePoll::Denied)));
        assert!(matches!(poll("old").await, Ok(DevicePoll::Expired)));
        assert!(matches!(poll("unknown").await, Err(OAuthError::Rejected)));

        let tokens = refresh_token(HostingProvider::Gitlab, &base, "lab-client", "refresh-1")
            .await
            .unwrap();
        assert_eq!(tokens.access_token.as_str(), "access-2");
        assert_eq!(
            tokens.refresh_token.as_ref().map(|token| token.as_str()),
            Some("refresh-2")
        );
        assert_eq!(tokens.expires_in, Some(Duration::from_secs(7200)));
        assert_eq!(tokens.scopes.map(|scopes| scopes.len()), Some(3));
        assert!(matches!(
            refresh_token(HostingProvider::Gitlab, &base, "lab-client", "revoked").await,
            Err(OAuthError::Rejected)
        ));
        assert!(matches!(
            start_device_flow(HostingProvider::Github, &base, "lab-client").await,
            Err(OAuthError::Rejected)
        ));
    }
}
