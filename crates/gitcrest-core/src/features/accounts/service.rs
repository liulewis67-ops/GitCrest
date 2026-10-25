use std::{
    collections::{hash_map::RandomState, HashMap},
    hash::{BuildHasher, Hasher},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::Duration,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{task::AbortHandle, time::Instant};
use zeroize::Zeroizing;

use super::providers::{
    api_base_url, oauth_base_url, oauth_git_username, DevicePoll, HostingProfile,
    HostingProviderClient, OAuthApps, OAuthError, OAuthTokens, ProfileError,
};
use crate::{
    credentials::{
        normalize_host, AccountSecret, AccountSecretStore, AccountSelections,
        AccountTokenRefresher, CredentialError, RefreshFuture,
    },
    domain::{
        account::{AccountAuthKind, AccountState, HostingAccount, HostingProvider},
        time::unix_time_ms,
    },
    events::publisher::EventBus,
    ports::accounts::HostingAccountStorePort,
};

const MAX_TOKEN_BYTES: usize = 64 * 1024;
/// OAuth tokens this close to expiry are renewed before Git uses them.
const REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;
/// A finished device flow stays readable this long so the sign-in dialog can show its outcome.
const FINISHED_FLOW_RETENTION_MS: i64 = 10 * 60 * 1000;
const MAX_DEVICE_FLOWS: usize = 8;
/// Consecutive network failures a device flow rides out before giving up.
const MAX_POLL_FAILURES: u32 = 3;
#[cfg(not(test))]
const MIN_POLL_INTERVAL: Duration = Duration::from_secs(1);
#[cfg(test)]
const MIN_POLL_INTERVAL: Duration = Duration::ZERO;
/// RFC 8628 asks clients to poll 5 seconds slower after each `slow_down`.
#[cfg(not(test))]
const SLOW_DOWN_STEP: Duration = Duration::from_secs(5);
#[cfg(test)]
const SLOW_DOWN_STEP: Duration = Duration::from_millis(5);
const ACCOUNTS_CHANGED_EVENT: &str = "accounts.changed";
const DEVICE_FLOW_UPDATED_EVENT: &str = "accounts.deviceFlow.updated";

static NEXT_RANDOM_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccountError {
    InvalidInput,
    NotFound,
    TokenRejected,
    ProviderUnreachable,
    StorageUnavailable,
    CredentialsUnavailable,
    /// Browser sign-in has no OAuth application for this provider and host.
    ProviderNotConfigured,
    FlowNotFound,
    /// The provider refused the browser sign-in request itself, for example because the OAuth
    /// application is disabled.
    SignInRejected,
}

impl From<CredentialError> for AccountError {
    fn from(error: CredentialError) -> Self {
        match error {
            CredentialError::InvalidInput => Self::InvalidInput,
            CredentialError::Unavailable => Self::CredentialsUnavailable,
        }
    }
}

impl From<ProfileError> for AccountError {
    fn from(error: ProfileError) -> Self {
        match error {
            ProfileError::TokenRejected => Self::TokenRejected,
            ProfileError::ProviderUnreachable => Self::ProviderUnreachable,
        }
    }
}

/// Account metadata as the API returns it. Tokens never leave the core.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountSummary {
    pub(crate) account_id: String,
    pub(crate) provider: HostingProvider,
    pub(crate) host: String,
    pub(crate) login: String,
    pub(crate) display_name: Option<String>,
    pub(crate) avatar_url: Option<String>,
    pub(crate) auth_kind: AccountAuthKind,
    pub(crate) scopes: Vec<String>,
    pub(crate) token_expires_at_ms: Option<i64>,
    pub(crate) state: AccountState,
    pub(crate) selected: bool,
    pub(crate) created_at_ms: i64,
    pub(crate) last_validated_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSignInHost {
    pub(crate) provider: HostingProvider,
    pub(crate) host: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountList {
    pub(crate) accounts: Vec<AccountSummary>,
    /// Where browser sign-in is available; every other host signs in with an access token.
    pub(crate) browser_sign_in: Vec<BrowserSignInHost>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DeviceFlowStatus {
    Pending,
    Completed(AccountSummary),
    Denied,
    Expired,
    Failed(AccountError),
}

impl DeviceFlowStatus {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed(_) => "completed",
            Self::Denied => "denied",
            Self::Expired => "expired",
            Self::Failed(_) => "failed",
        }
    }
}

/// A browser sign-in waiting for the user to enter `user_code` on the provider's page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeviceFlowSnapshot {
    pub(crate) flow_id: String,
    pub(crate) provider: HostingProvider,
    pub(crate) host: String,
    pub(crate) user_code: String,
    pub(crate) verification_uri: String,
    pub(crate) verification_uri_complete: Option<String>,
    pub(crate) expires_at_ms: i64,
    pub(crate) status: DeviceFlowStatus,
}

struct DeviceFlow {
    snapshot: DeviceFlowSnapshot,
    finished_at_ms: Option<i64>,
    poller: Option<AbortHandle>,
}

impl DeviceFlow {
    fn stop(&mut self) {
        if let Some(poller) = self.poller.take() {
            poller.abort();
        }
    }
}

/// The token and its metadata from one sign-in, before it is stored.
struct NewCredential {
    auth_kind: AccountAuthKind,
    git_username: String,
    token: Zeroizing<String>,
    refresh_token: Option<Zeroizing<String>>,
    scopes: Vec<String>,
    token_expires_at_ms: Option<i64>,
}

#[derive(Clone)]
pub(crate) struct AccountService {
    store: Arc<dyn HostingAccountStorePort>,
    secrets: Arc<dyn AccountSecretStore>,
    providers: Arc<dyn HostingProviderClient>,
    selections: AccountSelections,
    oauth_apps: Arc<OAuthApps>,
    events: EventBus,
    /// Serializes sign-in, switching and sign-out so the keyring, the database and the askpass
    /// selection cache move together.
    mutation: Arc<tokio::sync::Mutex<()>>,
    /// Refresh tokens rotate on use, so two refreshes must never overlap. Taken before
    /// `mutation`, never after it.
    refresh: Arc<tokio::sync::Mutex<()>>,
    flows: Arc<Mutex<HashMap<String, DeviceFlow>>>,
}

impl AccountService {
    pub(crate) fn new(
        store: Arc<dyn HostingAccountStorePort>,
        secrets: Arc<dyn AccountSecretStore>,
        providers: Arc<dyn HostingProviderClient>,
        selections: AccountSelections,
    ) -> Self {
        if let Ok(current) = store.list_hosting_account_selections() {
            selections.replace(current);
        }
        Self {
            store,
            secrets,
            providers,
            selections,
            oauth_apps: Arc::new(OAuthApps::default()),
            events: EventBus::default(),
            mutation: Arc::new(tokio::sync::Mutex::new(())),
            refresh: Arc::new(tokio::sync::Mutex::new(())),
            flows: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn with_oauth_apps(mut self, oauth_apps: OAuthApps) -> Self {
        self.oauth_apps = Arc::new(oauth_apps);
        self
    }

    pub(crate) fn with_events(mut self, events: EventBus) -> Self {
        self.events = events;
        self
    }

    pub(crate) async fn list(&self) -> Result<AccountList, AccountError> {
        let store = self.store.clone();
        let browser_sign_in = self
            .oauth_apps
            .browser_sign_in_hosts()
            .into_iter()
            .map(|(provider, host)| BrowserSignInHost {
                provider,
                host: host.to_owned(),
            })
            .collect();
        blocking(move || {
            let accounts = store
                .list_hosting_accounts()
                .map_err(|_| AccountError::StorageUnavailable)?;
            let selections = store
                .list_hosting_account_selections()
                .map_err(|_| AccountError::StorageUnavailable)?;
            Ok(AccountList {
                accounts: accounts
                    .into_iter()
                    .map(|account| summary(account, &selections))
                    .collect(),
                browser_sign_in,
            })
        })
        .await
    }

    /// Validates the token with the provider, then stores it. Signing in again as the same
    /// provider user replaces that account's token instead of adding a second account. The first
    /// account on a host becomes the one Git uses for it.
    pub(crate) async fn sign_in_with_token(
        &self,
        provider: HostingProvider,
        host: &str,
        token: &str,
    ) -> Result<AccountSummary, AccountError> {
        let host = normalize_host(host)?;
        let token = Zeroizing::new(token.trim().to_owned());
        if token.is_empty()
            || token.len() > MAX_TOKEN_BYTES
            || token
                .chars()
                .any(|character| character.is_control() || character == ' ')
        {
            return Err(AccountError::InvalidInput);
        }
        let api_base_url = api_base_url(provider, &host);
        let profile = self
            .providers
            .fetch_profile(provider, &api_base_url, &token)
            .await?;
        let credential = NewCredential {
            auth_kind: AccountAuthKind::Token,
            git_username: profile.login.clone(),
            token,
            refresh_token: None,
            scopes: profile.scopes.clone().unwrap_or_default(),
            token_expires_at_ms: profile.token_expires_at_ms,
        };
        self.save_sign_in(provider, host, api_base_url, profile, credential)
            .await
    }

    /// Starts a browser sign-in. The user enters the returned code on the provider's page while
    /// the core polls the provider in the background; `device_flow` reports the outcome.
    pub(crate) async fn start_device_flow(
        &self,
        provider: HostingProvider,
        host: &str,
    ) -> Result<DeviceFlowSnapshot, AccountError> {
        let host = normalize_host(host)?;
        let client_id = self
            .oauth_apps
            .client_id(provider, &host)
            .ok_or(AccountError::ProviderNotConfigured)?
            .to_owned();
        let oauth_base_url = oauth_base_url(&host);
        let authorization = self
            .providers
            .start_device_flow(provider, &oauth_base_url, &client_id)
            .await
            .map_err(|error| match error {
                OAuthError::Rejected => AccountError::SignInRejected,
                OAuthError::ProviderUnreachable => AccountError::ProviderUnreachable,
            })?;
        // The dialog opens this page in the system browser, so it must be the provider's own.
        if !is_provider_page(&authorization.verification_uri, &oauth_base_url) {
            return Err(AccountError::ProviderUnreachable);
        }
        let now = unix_time_ms();
        let snapshot = DeviceFlowSnapshot {
            flow_id: random_id("flow_"),
            provider,
            host: host.clone(),
            user_code: authorization.user_code,
            verification_uri: authorization.verification_uri,
            verification_uri_complete: authorization
                .verification_uri_complete
                .filter(|uri| is_provider_page(uri, &oauth_base_url)),
            expires_at_ms: now.saturating_add(duration_ms(authorization.expires_in)),
            status: DeviceFlowStatus::Pending,
        };
        {
            let mut flows = self.lock_flows();
            prune_flows(&mut flows, now);
            // Starting again replaces a sign-in still waiting for the same provider and host.
            flows.retain(|_, flow| {
                let replaced = flow.snapshot.status == DeviceFlowStatus::Pending
                    && flow.snapshot.provider == provider
                    && flow.snapshot.host == host;
                if replaced {
                    flow.stop();
                }
                !replaced
            });
            while flows.len() >= MAX_DEVICE_FLOWS {
                let Some(oldest) = flows
                    .iter()
                    .min_by_key(|(_, flow)| flow.snapshot.expires_at_ms)
                    .map(|(flow_id, _)| flow_id.clone())
                else {
                    break;
                };
                if let Some(mut flow) = flows.remove(&oldest) {
                    flow.stop();
                }
            }
            flows.insert(
                snapshot.flow_id.clone(),
                DeviceFlow {
                    snapshot: snapshot.clone(),
                    finished_at_ms: None,
                    poller: None,
                },
            );
        }
        let poller = tokio::spawn(self.clone().poll_device_flow(
            snapshot.flow_id.clone(),
            provider,
            host,
            client_id,
            authorization.device_code,
            authorization.interval.max(MIN_POLL_INTERVAL),
            Instant::now() + authorization.expires_in,
        ));
        if let Some(flow) = self.lock_flows().get_mut(&snapshot.flow_id) {
            if flow.finished_at_ms.is_none() {
                flow.poller = Some(poller.abort_handle());
            }
        }
        Ok(snapshot)
    }

    pub(crate) fn device_flow(&self, flow_id: &str) -> Result<DeviceFlowSnapshot, AccountError> {
        let mut flows = self.lock_flows();
        prune_flows(&mut flows, unix_time_ms());
        flows
            .get(flow_id)
            .map(|flow| flow.snapshot.clone())
            .ok_or(AccountError::FlowNotFound)
    }

    pub(crate) fn cancel_device_flow(&self, flow_id: &str) -> Result<(), AccountError> {
        let mut flow = self
            .lock_flows()
            .remove(flow_id)
            .ok_or(AccountError::FlowNotFound)?;
        flow.stop();
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn poll_device_flow(
        self,
        flow_id: String,
        provider: HostingProvider,
        host: String,
        client_id: String,
        device_code: Zeroizing<String>,
        mut interval: Duration,
        deadline: Instant,
    ) {
        let oauth_base_url = oauth_base_url(&host);
        let mut failures = 0;
        let status = loop {
            tokio::time::sleep(interval).await;
            if Instant::now() >= deadline {
                break DeviceFlowStatus::Expired;
            }
            match self
                .providers
                .poll_device_flow(provider, &oauth_base_url, &client_id, &device_code)
                .await
            {
                Ok(DevicePoll::Pending) => failures = 0,
                Ok(DevicePoll::SlowDown) => {
                    failures = 0;
                    interval += SLOW_DOWN_STEP;
                }
                Ok(DevicePoll::Granted(tokens)) => {
                    break match self.complete_device_sign_in(provider, &host, tokens).await {
                        Ok(account) => DeviceFlowStatus::Completed(account),
                        Err(error) => DeviceFlowStatus::Failed(error),
                    };
                }
                Ok(DevicePoll::Denied) => break DeviceFlowStatus::Denied,
                Ok(DevicePoll::Expired) => break DeviceFlowStatus::Expired,
                Err(OAuthError::Rejected) => {
                    break DeviceFlowStatus::Failed(AccountError::SignInRejected)
                }
                Err(OAuthError::ProviderUnreachable) => {
                    failures += 1;
                    if failures >= MAX_POLL_FAILURES {
                        break DeviceFlowStatus::Failed(AccountError::ProviderUnreachable);
                    }
                }
            }
        };
        let status_name = status.as_str();
        let finished = {
            let mut flows = self.lock_flows();
            match flows.get_mut(&flow_id) {
                Some(flow) => {
                    flow.snapshot.status = status;
                    flow.finished_at_ms = Some(unix_time_ms());
                    flow.poller = None;
                    true
                }
                // Cancelled while the provider answered.
                None => false,
            }
        };
        if finished {
            self.events.publish(
                None,
                DEVICE_FLOW_UPDATED_EVENT,
                serde_json::json!({ "flowId": flow_id, "status": status_name }),
            );
        }
    }

    async fn complete_device_sign_in(
        &self,
        provider: HostingProvider,
        host: &str,
        tokens: OAuthTokens,
    ) -> Result<AccountSummary, AccountError> {
        let api_base_url = api_base_url(provider, host);
        let profile = self
            .providers
            .fetch_profile(provider, &api_base_url, &tokens.access_token)
            .await?;
        let credential = NewCredential {
            auth_kind: AccountAuthKind::Oauth,
            git_username: oauth_git_username(provider, &profile.login),
            token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            scopes: tokens
                .scopes
                .or_else(|| profile.scopes.clone())
                .unwrap_or_default(),
            token_expires_at_ms: tokens.expires_in.map(expiry_from_now),
        };
        self.save_sign_in(provider, host.to_owned(), api_base_url, profile, credential)
            .await
    }

    async fn save_sign_in(
        &self,
        provider: HostingProvider,
        host: String,
        api_base_url: String,
        profile: HostingProfile,
        credential: NewCredential,
    ) -> Result<AccountSummary, AccountError> {
        let _guard = self.mutation.lock().await;
        let store = self.store.clone();
        let secrets = self.secrets.clone();
        let selections = self.selections.clone();
        let summary = blocking(move || {
            let existing = store
                .list_hosting_accounts()
                .map_err(|_| AccountError::StorageUnavailable)?
                .into_iter()
                .find(|account| {
                    account.provider == provider
                        && account.host == host
                        && account.remote_user_id == profile.remote_user_id
                });
            let now = unix_time_ms();
            let account = HostingAccount {
                account_id: existing
                    .as_ref()
                    .map_or_else(|| random_id("acct_"), |account| account.account_id.clone()),
                provider,
                host: host.clone(),
                api_base_url,
                remote_user_id: profile.remote_user_id,
                login: profile.login,
                display_name: profile.display_name,
                avatar_url: profile.avatar_url,
                auth_kind: credential.auth_kind,
                scopes: credential.scopes,
                token_expires_at_ms: credential.token_expires_at_ms,
                state: AccountState::Active,
                created_at_ms: existing
                    .as_ref()
                    .map_or(now, |account| account.created_at_ms),
                last_validated_at_ms: now,
            };
            secrets.set(
                &account.account_id,
                &AccountSecret {
                    git_username: credential.git_username,
                    token: credential.token,
                    refresh_token: credential.refresh_token,
                },
            )?;
            if store.save_hosting_account(&account).is_err() {
                if existing.is_none() {
                    let _ = secrets.delete(&account.account_id);
                }
                return Err(AccountError::StorageUnavailable);
            }
            let mut current = store
                .list_hosting_account_selections()
                .map_err(|_| AccountError::StorageUnavailable)?;
            if !current
                .iter()
                .any(|(selected_host, _)| *selected_host == host)
            {
                store
                    .select_hosting_account(&host, &account.account_id)
                    .map_err(|_| AccountError::StorageUnavailable)?;
                current = store
                    .list_hosting_account_selections()
                    .map_err(|_| AccountError::StorageUnavailable)?;
            }
            selections.replace(current.clone());
            Ok(summary(account, &current))
        })
        .await?;
        self.publish_changed();
        Ok(summary)
    }

    /// Makes this account the one Git uses for its host.
    pub(crate) async fn select(&self, account_id: &str) -> Result<AccountSummary, AccountError> {
        let _guard = self.mutation.lock().await;
        let store = self.store.clone();
        let selections = self.selections.clone();
        let account_id = account_id.to_owned();
        let summary = blocking(move || {
            let account = find_account(store.as_ref(), &account_id)?;
            store
                .select_hosting_account(&account.host, &account.account_id)
                .map_err(|_| AccountError::StorageUnavailable)?;
            let current = store
                .list_hosting_account_selections()
                .map_err(|_| AccountError::StorageUnavailable)?;
            selections.replace(current.clone());
            Ok(summary(account, &current))
        })
        .await?;
        self.publish_changed();
        Ok(summary)
    }

    /// Checks the stored token with the provider and refreshes the profile. A rejected or missing
    /// token marks the account as needing sign-in instead of failing the request. An OAuth token
    /// that is about to expire, or that the provider rejects, is renewed first.
    pub(crate) async fn validate(&self, account_id: &str) -> Result<AccountSummary, AccountError> {
        let account = self.find(account_id).await?;
        let outcome = self.check_token(&account).await?;

        let _guard = self.mutation.lock().await;
        let store = self.store.clone();
        let account_id = account_id.to_owned();
        let (summary, state_changed) = blocking(move || {
            // The account may have been signed out or replaced while the provider answered.
            let mut current = find_account(store.as_ref(), &account_id)?;
            let previous_state = current.state;
            apply_validation(&mut current, outcome.as_ref(), unix_time_ms());
            store
                .save_hosting_account(&current)
                .map_err(|_| AccountError::StorageUnavailable)?;
            let selections = store
                .list_hosting_account_selections()
                .map_err(|_| AccountError::StorageUnavailable)?;
            let state_changed = current.state != previous_state;
            Ok((summary(current, &selections), state_changed))
        })
        .await?;
        if state_changed {
            self.publish_changed();
        }
        Ok(summary)
    }

    /// The profile behind the account's token, or `None` when the provider no longer accepts it.
    async fn check_token(
        &self,
        account: &HostingAccount,
    ) -> Result<Option<HostingProfile>, AccountError> {
        let renewable = account.auth_kind == AccountAuthKind::Oauth;
        if renewable && expires_soon(account, unix_time_ms()) {
            if let Err(AccountError::ProviderUnreachable) =
                self.refresh_account(&account.account_id, true).await
            {
                return Err(AccountError::ProviderUnreachable);
            }
        }
        let Some(secret) = self.read_secret(&account.account_id).await? else {
            return Ok(None);
        };
        let profile = self.matching_profile(account, &secret.token).await?;
        if profile.is_some() || !renewable || secret.refresh_token.is_none() {
            return Ok(profile);
        }
        match self.refresh_account(&account.account_id, false).await {
            Ok(()) => {}
            Err(AccountError::ProviderUnreachable) => {
                return Err(AccountError::ProviderUnreachable)
            }
            Err(_) => return Ok(None),
        }
        match self.read_secret(&account.account_id).await? {
            Some(secret) => self.matching_profile(account, &secret.token).await,
            None => Ok(None),
        }
    }

    async fn matching_profile(
        &self,
        account: &HostingAccount,
        token: &str,
    ) -> Result<Option<HostingProfile>, AccountError> {
        match self
            .providers
            .fetch_profile(account.provider, &account.api_base_url, token)
            .await
        {
            Ok(profile) if profile.remote_user_id == account.remote_user_id => Ok(Some(profile)),
            Ok(_) | Err(ProfileError::TokenRejected) => Ok(None),
            Err(ProfileError::ProviderUnreachable) => Err(AccountError::ProviderUnreachable),
        }
    }

    /// Renews an OAuth account's access token with its refresh token. With `only_if_expiring`,
    /// a token another caller renewed meanwhile is left alone. A refresh token the provider
    /// rejects marks the account as needing sign-in.
    async fn refresh_account(
        &self,
        account_id: &str,
        only_if_expiring: bool,
    ) -> Result<(), AccountError> {
        let _refresh = self.refresh.lock().await;
        let account = self.find(account_id).await?;
        if only_if_expiring && !expires_soon(&account, unix_time_ms()) {
            return Ok(());
        }
        let client_id = self
            .oauth_apps
            .client_id(account.provider, &account.host)
            .ok_or(AccountError::ProviderNotConfigured)?
            .to_owned();
        let secret = self
            .read_secret(account_id)
            .await?
            .ok_or(AccountError::TokenRejected)?;
        let refresh_token = secret
            .refresh_token
            .clone()
            .ok_or(AccountError::TokenRejected)?;
        let tokens = match self
            .providers
            .refresh_token(
                account.provider,
                &oauth_base_url(&account.host),
                &client_id,
                &refresh_token,
            )
            .await
        {
            Ok(tokens) => tokens,
            Err(OAuthError::Rejected) => {
                self.mark_needs_reauth(account_id).await?;
                return Err(AccountError::TokenRejected);
            }
            Err(OAuthError::ProviderUnreachable) => return Err(AccountError::ProviderUnreachable),
        };

        let _guard = self.mutation.lock().await;
        let store = self.store.clone();
        let secrets = self.secrets.clone();
        let account_id = account_id.to_owned();
        let reactivated = blocking(move || {
            let mut current = find_account(store.as_ref(), &account_id)?;
            // Rotated refresh tokens are single-use: the new pair replaces the old one in one
            // keyring entry, so a crash never leaves a used refresh token behind.
            secrets.set(
                &account_id,
                &AccountSecret {
                    git_username: secret.git_username,
                    token: tokens.access_token,
                    refresh_token: tokens.refresh_token.or(Some(refresh_token)),
                },
            )?;
            let reactivated = current.state != AccountState::Active;
            current.state = AccountState::Active;
            current.token_expires_at_ms = tokens.expires_in.map(expiry_from_now);
            if let Some(scopes) = tokens.scopes {
                current.scopes = scopes;
            }
            store
                .save_hosting_account(&current)
                .map_err(|_| AccountError::StorageUnavailable)?;
            Ok(reactivated)
        })
        .await?;
        if reactivated {
            self.publish_changed();
        }
        Ok(())
    }

    async fn mark_needs_reauth(&self, account_id: &str) -> Result<(), AccountError> {
        let _guard = self.mutation.lock().await;
        let store = self.store.clone();
        let account_id = account_id.to_owned();
        let changed = blocking(move || {
            let mut account = find_account(store.as_ref(), &account_id)?;
            if account.state == AccountState::NeedsReauth {
                return Ok(false);
            }
            account.state = AccountState::NeedsReauth;
            account.last_validated_at_ms = unix_time_ms();
            store
                .save_hosting_account(&account)
                .map_err(|_| AccountError::StorageUnavailable)?;
            Ok(true)
        })
        .await?;
        if changed {
            self.publish_changed();
        }
        Ok(())
    }

    /// Git reported that a remote refused its credentials. Re-checks the accounts that answered
    /// for the hosts named in its output, so one whose token stopped working shows as needing
    /// sign-in rather than failing again on the next push.
    pub(crate) fn authentication_failed(&self, git_output: &str) {
        for host in https_hosts(git_output) {
            if let Some(account_id) = self.selections.account_for_host(&host) {
                let service = self.clone();
                tokio::spawn(async move {
                    let _ = service.validate(&account_id).await;
                });
            }
        }
    }

    /// Forgets the account and its token. When it was the account Git used for its host, another
    /// account on that host takes over, preferring one whose token still works. A GitLab browser
    /// sign-in's token is also revoked; GitHub needs the client secret for that.
    pub(crate) async fn sign_out(&self, account_id: &str) -> Result<(), AccountError> {
        let _guard = self.mutation.lock().await;
        let store = self.store.clone();
        let secrets = self.secrets.clone();
        let selections = self.selections.clone();
        let account_id = account_id.to_owned();
        let (account, secret) = blocking(move || {
            let account = find_account(store.as_ref(), &account_id)?;
            let was_selected = store
                .list_hosting_account_selections()
                .map_err(|_| AccountError::StorageUnavailable)?
                .iter()
                .any(|(_, selected)| *selected == account.account_id);
            let secret = if account.auth_kind == AccountAuthKind::Oauth {
                secrets.get(&account.account_id).ok().flatten()
            } else {
                None
            };
            // Delete the secret first so a failure in between never leaves a token behind an
            // account the user can no longer see.
            secrets.delete(&account.account_id)?;
            store
                .delete_hosting_account(&account.account_id)
                .map_err(|_| AccountError::StorageUnavailable)?;
            if was_selected {
                let replacement = store
                    .list_hosting_accounts()
                    .map_err(|_| AccountError::StorageUnavailable)?
                    .into_iter()
                    .filter(|candidate| candidate.host == account.host)
                    .max_by_key(|candidate| {
                        (
                            candidate.state == AccountState::Active,
                            candidate.last_validated_at_ms,
                        )
                    });
                if let Some(replacement) = replacement {
                    store
                        .select_hosting_account(&replacement.host, &replacement.account_id)
                        .map_err(|_| AccountError::StorageUnavailable)?;
                }
            }
            selections.replace(
                store
                    .list_hosting_account_selections()
                    .map_err(|_| AccountError::StorageUnavailable)?,
            );
            Ok((account, secret))
        })
        .await?;
        self.publish_changed();
        if let (Some(secret), Some(client_id)) = (
            secret,
            self.oauth_apps.client_id(account.provider, &account.host),
        ) {
            let providers = self.providers.clone();
            let client_id = client_id.to_owned();
            tokio::spawn(async move {
                let oauth_base_url = oauth_base_url(&account.host);
                for token in [Some(secret.token), secret.refresh_token]
                    .into_iter()
                    .flatten()
                {
                    providers
                        .revoke_token(account.provider, &oauth_base_url, &client_id, &token)
                        .await;
                }
            });
        }
        Ok(())
    }

    async fn find(&self, account_id: &str) -> Result<HostingAccount, AccountError> {
        let store = self.store.clone();
        let account_id = account_id.to_owned();
        blocking(move || find_account(store.as_ref(), &account_id)).await
    }

    async fn read_secret(&self, account_id: &str) -> Result<Option<AccountSecret>, AccountError> {
        let secrets = self.secrets.clone();
        let account_id = account_id.to_owned();
        blocking(move || Ok(secrets.get(&account_id)?)).await
    }

    fn lock_flows(&self) -> MutexGuard<'_, HashMap<String, DeviceFlow>> {
        self.flows.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn publish_changed(&self) {
        self.events
            .publish(None, ACCOUNTS_CHANGED_EVENT, serde_json::json!({}));
    }
}

impl AccountTokenRefresher for AccountService {
    fn refresh_expiring_tokens(&self) -> RefreshFuture<'_> {
        Box::pin(async move {
            let store = self.store.clone();
            let now = unix_time_ms();
            let Ok(expiring) = blocking(move || {
                let selections = store
                    .list_hosting_account_selections()
                    .map_err(|_| AccountError::StorageUnavailable)?;
                Ok(store
                    .list_hosting_accounts()
                    .map_err(|_| AccountError::StorageUnavailable)?
                    .into_iter()
                    .filter(|account| {
                        account.auth_kind == AccountAuthKind::Oauth
                            && account.state == AccountState::Active
                            && expires_soon(account, now)
                            && selections
                                .iter()
                                .any(|(_, selected)| *selected == account.account_id)
                    })
                    .map(|account| account.account_id)
                    .collect::<Vec<_>>())
            })
            .await
            else {
                return;
            };
            for account_id in expiring {
                let _ = self.refresh_account(&account_id, true).await;
            }
        })
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, AccountError> + Send + 'static,
) -> Result<T, AccountError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| AccountError::StorageUnavailable)?
}

fn find_account(
    store: &dyn HostingAccountStorePort,
    account_id: &str,
) -> Result<HostingAccount, AccountError> {
    store
        .list_hosting_accounts()
        .map_err(|_| AccountError::StorageUnavailable)?
        .into_iter()
        .find(|account| account.account_id == account_id)
        .ok_or(AccountError::NotFound)
}

fn apply_validation(account: &mut HostingAccount, profile: Option<&HostingProfile>, now: i64) {
    account.last_validated_at_ms = now;
    let Some(profile) = profile else {
        account.state = AccountState::NeedsReauth;
        return;
    };
    account.state = AccountState::Active;
    account.login = profile.login.clone();
    account.display_name = profile.display_name.clone();
    account.avatar_url = profile.avatar_url.clone();
    if let Some(scopes) = &profile.scopes {
        account.scopes = scopes.clone();
    }
    // An OAuth token's expiry comes from the token response, not the profile.
    if account.auth_kind == AccountAuthKind::Token {
        account.token_expires_at_ms = profile.token_expires_at_ms;
    }
}

fn expires_soon(account: &HostingAccount, now: i64) -> bool {
    account
        .token_expires_at_ms
        .is_some_and(|expires_at| expires_at.saturating_sub(now) <= REFRESH_MARGIN_MS)
}

fn duration_ms(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

fn expiry_from_now(lifetime: Duration) -> i64 {
    unix_time_ms().saturating_add(duration_ms(lifetime))
}

fn is_provider_page(uri: &str, oauth_base_url: &str) -> bool {
    uri.strip_prefix(oauth_base_url)
        .is_some_and(|path| path.starts_with('/'))
}

fn prune_flows(flows: &mut HashMap<String, DeviceFlow>, now: i64) {
    flows.retain(|_, flow| {
        let ended_at = flow.finished_at_ms.unwrap_or(flow.snapshot.expires_at_ms);
        let keep = now.saturating_sub(ended_at) <= FINISHED_FLOW_RETENTION_MS;
        if !keep {
            flow.stop();
        }
        keep
    });
}

/// Hosts of the `https://` URLs in Git's output, such as
/// `fatal: Authentication failed for 'https://github.com/owner/repo.git/'`.
fn https_hosts(text: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for (index, scheme) in text.match_indices("https://") {
        let authority = text[index + scheme.len()..]
            .split(|character: char| {
                matches!(character, '/' | '\'' | '"' | '`') || character.is_whitespace()
            })
            .next()
            .unwrap_or_default();
        let host = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        if let Ok(host) = normalize_host(host) {
            if !hosts.contains(&host) {
                hosts.push(host);
            }
        }
    }
    hosts
}

fn summary(account: HostingAccount, selections: &[(String, String)]) -> AccountSummary {
    let selected = selections
        .iter()
        .any(|(host, account_id)| *host == account.host && *account_id == account.account_id);
    AccountSummary {
        account_id: account.account_id,
        provider: account.provider,
        host: account.host,
        login: account.login,
        display_name: account.display_name,
        avatar_url: account.avatar_url,
        auth_kind: account.auth_kind,
        scopes: account.scopes,
        token_expires_at_ms: account.token_expires_at_ms,
        state: account.state,
        selected,
        created_at_ms: account.created_at_ms,
        last_validated_at_ms: account.last_validated_at_ms,
    }
}

pub(crate) fn is_valid_flow_id(value: &str) -> bool {
    value.strip_prefix("flow_").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

/// `prefix` followed by 32 unpredictable hex characters.
fn random_id(prefix: &str) -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(NEXT_RANDOM_ID.fetch_add(1, Ordering::Relaxed));
    let mut digest = Sha256::new();
    digest.update(hasher.finish().to_le_bytes());
    digest.update(RandomState::new().build_hasher().finish().to_le_bytes());
    digest.update(unix_time_ms().to_le_bytes());
    digest.update(std::process::id().to_le_bytes());
    let bytes = digest.finalize();
    let suffix: String = bytes[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{prefix}{suffix}")
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashMap, VecDeque},
        sync::{atomic::AtomicUsize, Mutex},
    };

    use super::*;
    use crate::{
        credentials::{is_valid_account_id, MemoryAccountSecretStore},
        features::accounts::providers::{DeviceAuthorization, ProfileFuture, ProviderFuture},
        storage::RepositoryStore,
    };

    /// Refresh token → (access token, rotated refresh token), or the provider's refusal.
    type RefreshTable = HashMap<String, Result<(String, String), OAuthError>>;

    /// Answers profile requests from a token → profile table (unknown tokens are rejected),
    /// device-flow polls from a queue (pending once it is empty), and refreshes from a
    /// refresh token → (access token, rotated refresh token) table.
    #[derive(Default)]
    struct FakeProfiles {
        profiles: Mutex<HashMap<String, Result<HostingProfile, ProfileError>>>,
        polls: Mutex<VecDeque<Result<DevicePoll, OAuthError>>>,
        verification_uri: Mutex<Option<String>>,
        refreshes: Mutex<RefreshTable>,
        refresh_calls: AtomicUsize,
        revoked: Mutex<Vec<String>>,
    }

    impl FakeProfiles {
        fn set(&self, token: &str, profile: Result<HostingProfile, ProfileError>) {
            self.profiles
                .lock()
                .unwrap()
                .insert(token.to_owned(), profile);
        }

        fn queue_polls(&self, polls: impl IntoIterator<Item = Result<DevicePoll, OAuthError>>) {
            self.polls.lock().unwrap().extend(polls);
        }

        fn set_refresh(&self, refresh_token: &str, result: Result<(&str, &str), OAuthError>) {
            self.refreshes.lock().unwrap().insert(
                refresh_token.to_owned(),
                result.map(|(access, refresh)| (access.to_owned(), refresh.to_owned())),
            );
        }
    }

    impl HostingProviderClient for FakeProfiles {
        fn fetch_profile<'a>(
            &'a self,
            _provider: HostingProvider,
            _api_base_url: &'a str,
            token: &'a str,
        ) -> ProfileFuture<'a> {
            let result = self
                .profiles
                .lock()
                .unwrap()
                .get(token)
                .cloned()
                .unwrap_or(Err(ProfileError::TokenRejected));
            Box::pin(async move { result })
        }

        fn start_device_flow<'a>(
            &'a self,
            _provider: HostingProvider,
            oauth_base_url: &'a str,
            _client_id: &'a str,
        ) -> ProviderFuture<'a, Result<DeviceAuthorization, OAuthError>> {
            let verification_uri = self
                .verification_uri
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| format!("{oauth_base_url}/login/device"));
            Box::pin(async move {
                Ok(DeviceAuthorization {
                    device_code: Zeroizing::new("device-code".into()),
                    user_code: "ABCD-1234".into(),
                    verification_uri,
                    verification_uri_complete: None,
                    expires_in: Duration::from_secs(60),
                    interval: Duration::from_millis(1),
                })
            })
        }

        fn poll_device_flow<'a>(
            &'a self,
            _provider: HostingProvider,
            _oauth_base_url: &'a str,
            _client_id: &'a str,
            _device_code: &'a str,
        ) -> ProviderFuture<'a, Result<DevicePoll, OAuthError>> {
            let poll = self
                .polls
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(DevicePoll::Pending));
            Box::pin(async move { poll })
        }

        fn refresh_token<'a>(
            &'a self,
            _provider: HostingProvider,
            _oauth_base_url: &'a str,
            _client_id: &'a str,
            refresh_token: &'a str,
        ) -> ProviderFuture<'a, Result<OAuthTokens, OAuthError>> {
            self.refresh_calls.fetch_add(1, Ordering::SeqCst);
            let result = self
                .refreshes
                .lock()
                .unwrap()
                .get(refresh_token)
                .cloned()
                .unwrap_or(Err(OAuthError::Rejected))
                .map(|(access, refresh)| tokens(&access, Some(&refresh), Some(7200)));
            Box::pin(async move { result })
        }

        fn revoke_token<'a>(
            &'a self,
            _provider: HostingProvider,
            _oauth_base_url: &'a str,
            _client_id: &'a str,
            token: &'a str,
        ) -> ProviderFuture<'a, ()> {
            self.revoked.lock().unwrap().push(token.to_owned());
            Box::pin(async {})
        }
    }

    fn tokens(access: &str, refresh: Option<&str>, expires_in_secs: Option<u64>) -> OAuthTokens {
        OAuthTokens {
            access_token: Zeroizing::new(access.into()),
            refresh_token: refresh.map(|token| Zeroizing::new(token.into())),
            expires_in: expires_in_secs.map(Duration::from_secs),
            scopes: None,
        }
    }

    async fn finished_flow(service: &AccountService, flow_id: &str) -> DeviceFlowSnapshot {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let flow = service.device_flow(flow_id).unwrap();
                if flow.status != DeviceFlowStatus::Pending {
                    return flow;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("the device flow did not finish")
    }

    async fn eventually(mut check: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !check() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("the condition never held");
    }

    fn profile(user_id: &str, login: &str) -> HostingProfile {
        HostingProfile {
            remote_user_id: user_id.into(),
            login: login.into(),
            display_name: None,
            avatar_url: None,
            scopes: Some(vec!["repo".into()]),
            token_expires_at_ms: None,
        }
    }

    struct Harness {
        service: AccountService,
        secrets: Arc<MemoryAccountSecretStore>,
        profiles: Arc<FakeProfiles>,
        selections: AccountSelections,
    }

    fn harness() -> Harness {
        harness_with_apps(OAuthApps::default())
    }

    fn harness_with_apps(apps: OAuthApps) -> Harness {
        let secrets = Arc::new(MemoryAccountSecretStore::default());
        let profiles = Arc::new(FakeProfiles::default());
        let selections = AccountSelections::default();
        let service = AccountService::new(
            Arc::new(RepositoryStore::default()),
            secrets.clone(),
            profiles.clone(),
            selections.clone(),
        )
        .with_oauth_apps(apps);
        Harness {
            service,
            secrets,
            profiles,
            selections,
        }
    }

    #[tokio::test]
    async fn signs_in_selects_the_first_account_and_replaces_tokens_for_the_same_user() {
        let harness = harness();
        harness.profiles.set("token-1", Ok(profile("1", "octocat")));
        harness
            .profiles
            .set("token-1b", Ok(profile("1", "octocat")));
        harness.profiles.set("token-2", Ok(profile("2", "hubot")));

        let first = harness
            .service
            .sign_in_with_token(HostingProvider::Github, "GitHub.com", " token-1\n")
            .await
            .unwrap();
        assert!(is_valid_account_id(&first.account_id));
        assert_eq!(first.host, "github.com");
        assert!(first.selected);
        assert_eq!(
            harness.selections.env_value(),
            Some(format!("github.com={}", first.account_id))
        );

        let second = harness
            .service
            .sign_in_with_token(HostingProvider::Github, "github.com", "token-2")
            .await
            .unwrap();
        assert!(!second.selected);

        let replaced = harness
            .service
            .sign_in_with_token(HostingProvider::Github, "github.com", "token-1b")
            .await
            .unwrap();
        assert_eq!(replaced.account_id, first.account_id);
        assert_eq!(replaced.created_at_ms, first.created_at_ms);
        assert_eq!(
            harness
                .secrets
                .get(&first.account_id)
                .unwrap()
                .unwrap()
                .token
                .as_str(),
            "token-1b"
        );
        assert_eq!(harness.service.list().await.unwrap().accounts.len(), 2);
    }

    #[tokio::test]
    async fn rejects_bad_input_and_tokens_the_provider_refuses_without_storing_anything() {
        let harness = harness();
        for (host, token) in [
            ("https://github.com", "token"),
            ("github.com", ""),
            ("github.com", "two words"),
        ] {
            assert_eq!(
                harness
                    .service
                    .sign_in_with_token(HostingProvider::Github, host, token)
                    .await,
                Err(AccountError::InvalidInput)
            );
        }
        assert_eq!(
            harness
                .service
                .sign_in_with_token(HostingProvider::Gitlab, "gitlab.com", "unknown")
                .await,
            Err(AccountError::TokenRejected)
        );
        assert!(harness.service.list().await.unwrap().accounts.is_empty());
    }

    #[tokio::test]
    async fn switches_accounts_and_hands_the_host_to_another_account_on_sign_out() {
        let harness = harness();
        harness.profiles.set("token-1", Ok(profile("1", "octocat")));
        harness.profiles.set("token-2", Ok(profile("2", "hubot")));
        harness.profiles.set("lab", Ok(profile("9", "tanuki")));
        let first = harness
            .service
            .sign_in_with_token(HostingProvider::Github, "github.com", "token-1")
            .await
            .unwrap();
        let second = harness
            .service
            .sign_in_with_token(HostingProvider::Github, "github.com", "token-2")
            .await
            .unwrap();
        let gitlab = harness
            .service
            .sign_in_with_token(HostingProvider::Gitlab, "gitlab.com", "lab")
            .await
            .unwrap();
        assert!(gitlab.selected);

        assert!(
            harness
                .service
                .select(&second.account_id)
                .await
                .unwrap()
                .selected
        );
        let accounts = harness.service.list().await.unwrap().accounts;
        assert!(
            !accounts
                .iter()
                .find(|account| account.account_id == first.account_id)
                .unwrap()
                .selected
        );

        harness.service.sign_out(&second.account_id).await.unwrap();
        assert!(harness.secrets.get(&second.account_id).unwrap().is_none());
        let accounts = harness.service.list().await.unwrap().accounts;
        assert_eq!(accounts.len(), 2);
        assert!(
            accounts
                .iter()
                .find(|account| account.account_id == first.account_id)
                .unwrap()
                .selected
        );

        harness.service.sign_out(&first.account_id).await.unwrap();
        assert_eq!(
            harness.selections.env_value(),
            Some(format!("gitlab.com={}", gitlab.account_id))
        );
        assert_eq!(
            harness.service.sign_out(&first.account_id).await,
            Err(AccountError::NotFound)
        );
        assert_eq!(
            harness.service.select("acct_missing").await,
            Err(AccountError::NotFound)
        );
    }

    #[tokio::test]
    async fn validation_refreshes_the_profile_or_marks_the_account_for_sign_in() {
        let harness = harness();
        harness.profiles.set("token", Ok(profile("1", "octocat")));
        let account = harness
            .service
            .sign_in_with_token(HostingProvider::Github, "github.com", "token")
            .await
            .unwrap();

        harness.profiles.set(
            "token",
            Ok(HostingProfile {
                display_name: Some("Renamed".into()),
                ..profile("1", "octocat-renamed")
            }),
        );
        let refreshed = harness.service.validate(&account.account_id).await.unwrap();
        assert_eq!(refreshed.login, "octocat-renamed");
        assert_eq!(refreshed.display_name.as_deref(), Some("Renamed"));
        assert_eq!(refreshed.state, AccountState::Active);

        harness
            .profiles
            .set("token", Err(ProfileError::ProviderUnreachable));
        assert_eq!(
            harness.service.validate(&account.account_id).await,
            Err(AccountError::ProviderUnreachable)
        );

        harness
            .profiles
            .set("token", Err(ProfileError::TokenRejected));
        let rejected = harness.service.validate(&account.account_id).await.unwrap();
        assert_eq!(rejected.state, AccountState::NeedsReauth);
        assert!(rejected.selected);

        harness.profiles.set("token", Ok(profile("1", "octocat")));
        assert_eq!(
            harness
                .service
                .validate(&account.account_id)
                .await
                .unwrap()
                .state,
            AccountState::Active
        );
    }

    fn gitlab_apps() -> OAuthApps {
        OAuthApps::new(None, Some("lab-client"))
    }

    /// Signs in to GitLab.com through a device flow that grants `access` / `refresh` with the
    /// given lifetime.
    async fn browser_sign_in(
        harness: &Harness,
        access: &str,
        refresh: &str,
        expires_in_secs: u64,
    ) -> AccountSummary {
        harness.profiles.set(access, Ok(profile("9", "tanuki")));
        harness.profiles.queue_polls([Ok(DevicePoll::Granted(tokens(
            access,
            Some(refresh),
            Some(expires_in_secs),
        )))]);
        let flow = harness
            .service
            .start_device_flow(HostingProvider::Gitlab, "gitlab.com")
            .await
            .unwrap();
        match finished_flow(&harness.service, &flow.flow_id).await.status {
            DeviceFlowStatus::Completed(account) => account,
            status => panic!("unexpected device flow status {status:?}"),
        }
    }

    #[tokio::test]
    async fn browser_sign_in_stores_an_oauth_account_and_announces_it() {
        let events = EventBus::default();
        let mut received = events.subscribe();
        let mut harness = harness_with_apps(gitlab_apps());
        harness.service = harness.service.clone().with_events(events);
        harness.profiles.set("access-1", Ok(profile("9", "tanuki")));
        harness.profiles.queue_polls([
            Ok(DevicePoll::Pending),
            Ok(DevicePoll::SlowDown),
            Ok(DevicePoll::Granted(tokens(
                "access-1",
                Some("refresh-1"),
                Some(7200),
            ))),
        ]);

        assert_eq!(
            harness.service.list().await.unwrap().browser_sign_in,
            vec![BrowserSignInHost {
                provider: HostingProvider::Gitlab,
                host: "gitlab.com".into()
            }]
        );
        let flow = harness
            .service
            .start_device_flow(HostingProvider::Gitlab, "GitLab.com")
            .await
            .unwrap();
        assert!(is_valid_flow_id(&flow.flow_id));
        assert_eq!(flow.status, DeviceFlowStatus::Pending);
        assert_eq!(flow.user_code, "ABCD-1234");
        assert_eq!(flow.verification_uri, "https://gitlab.com/login/device");

        let DeviceFlowStatus::Completed(account) =
            finished_flow(&harness.service, &flow.flow_id).await.status
        else {
            panic!("the device flow did not sign in");
        };
        assert_eq!(account.auth_kind, AccountAuthKind::Oauth);
        assert_eq!(account.login, "tanuki");
        assert!(account.selected);
        assert!(account.token_expires_at_ms.unwrap() > unix_time_ms() + 7_000_000);
        let secret = harness.secrets.get(&account.account_id).unwrap().unwrap();
        assert_eq!(secret.git_username, "oauth2");
        assert_eq!(secret.token.as_str(), "access-1");
        assert_eq!(
            secret.refresh_token.as_ref().map(|token| token.as_str()),
            Some("refresh-1")
        );

        let mut event_types = Vec::new();
        while let Ok(event) = received.try_recv() {
            event_types.push(event.event_type);
        }
        assert_eq!(
            event_types,
            vec![ACCOUNTS_CHANGED_EVENT, DEVICE_FLOW_UPDATED_EVENT]
        );
    }

    #[tokio::test]
    async fn browser_sign_in_handles_unconfigured_hosts_denial_restarts_and_cancellation() {
        let harness = harness_with_apps(gitlab_apps());
        for (provider, host) in [
            (HostingProvider::Github, "github.com"),
            (HostingProvider::Gitlab, "gitlab.example.com"),
        ] {
            assert_eq!(
                harness.service.start_device_flow(provider, host).await,
                Err(AccountError::ProviderNotConfigured)
            );
        }

        *harness.profiles.verification_uri.lock().unwrap() =
            Some("https://gitlab.com.evil.example/device".into());
        assert_eq!(
            harness
                .service
                .start_device_flow(HostingProvider::Gitlab, "gitlab.com")
                .await,
            Err(AccountError::ProviderUnreachable)
        );
        *harness.profiles.verification_uri.lock().unwrap() = None;

        harness.profiles.queue_polls([Ok(DevicePoll::Denied)]);
        let denied = harness
            .service
            .start_device_flow(HostingProvider::Gitlab, "gitlab.com")
            .await
            .unwrap();
        assert_eq!(
            finished_flow(&harness.service, &denied.flow_id)
                .await
                .status,
            DeviceFlowStatus::Denied
        );

        let first = harness
            .service
            .start_device_flow(HostingProvider::Gitlab, "gitlab.com")
            .await
            .unwrap();
        let second = harness
            .service
            .start_device_flow(HostingProvider::Gitlab, "gitlab.com")
            .await
            .unwrap();
        assert_eq!(
            harness.service.device_flow(&first.flow_id),
            Err(AccountError::FlowNotFound)
        );
        harness.service.cancel_device_flow(&second.flow_id).unwrap();
        assert_eq!(
            harness.service.cancel_device_flow(&second.flow_id),
            Err(AccountError::FlowNotFound)
        );
        assert!(harness.service.list().await.unwrap().accounts.is_empty());
    }

    #[tokio::test]
    async fn renews_expiring_tokens_before_git_runs_and_flags_rejected_refresh_tokens() {
        let harness = harness_with_apps(gitlab_apps());
        harness
            .selections
            .set_token_refresher(Arc::new(harness.service.clone()));
        let account = browser_sign_in(&harness, "access-1", "refresh-1", 60).await;
        harness
            .profiles
            .set_refresh("refresh-1", Ok(("access-2", "refresh-2")));

        harness.selections.refresh_expiring_tokens().await;
        let secret = harness.secrets.get(&account.account_id).unwrap().unwrap();
        assert_eq!(secret.token.as_str(), "access-2");
        assert_eq!(
            secret.refresh_token.as_ref().map(|token| token.as_str()),
            Some("refresh-2")
        );
        assert_eq!(secret.git_username, "oauth2");
        let renewed = &harness.service.list().await.unwrap().accounts[0];
        assert!(renewed.token_expires_at_ms.unwrap() > unix_time_ms() + 7_000_000);

        // A token that is not about to expire is left alone.
        harness.selections.refresh_expiring_tokens().await;
        assert_eq!(harness.profiles.refresh_calls.load(Ordering::SeqCst), 1);

        browser_sign_in(&harness, "access-3", "revoked", 60).await;
        harness.selections.refresh_expiring_tokens().await;
        let flagged = &harness.service.list().await.unwrap().accounts[0];
        assert_eq!(flagged.account_id, account.account_id);
        assert_eq!(flagged.state, AccountState::NeedsReauth);
        assert_eq!(
            harness
                .secrets
                .get(&account.account_id)
                .unwrap()
                .unwrap()
                .token
                .as_str(),
            "access-3"
        );
    }

    #[tokio::test]
    async fn validation_renews_an_oauth_token_the_provider_rejects() {
        let harness = harness_with_apps(gitlab_apps());
        let account = browser_sign_in(&harness, "access-1", "refresh-1", 7200).await;
        harness
            .profiles
            .set("access-1", Err(ProfileError::TokenRejected));
        harness.profiles.set("access-2", Ok(profile("9", "tanuki")));
        harness
            .profiles
            .set_refresh("refresh-1", Ok(("access-2", "refresh-2")));

        let validated = harness.service.validate(&account.account_id).await.unwrap();
        assert_eq!(validated.state, AccountState::Active);
        assert!(validated.token_expires_at_ms.is_some());
        assert_eq!(
            harness
                .secrets
                .get(&account.account_id)
                .unwrap()
                .unwrap()
                .token
                .as_str(),
            "access-2"
        );

        harness
            .profiles
            .set("access-2", Err(ProfileError::TokenRejected));
        let rejected = harness.service.validate(&account.account_id).await.unwrap();
        assert_eq!(rejected.state, AccountState::NeedsReauth);
    }

    #[tokio::test]
    async fn rechecks_the_account_git_used_when_a_remote_refuses_it() {
        let harness = harness();
        harness.profiles.set("token", Ok(profile("1", "octocat")));
        harness.profiles.set("lab", Ok(profile("9", "tanuki")));
        let github = harness
            .service
            .sign_in_with_token(HostingProvider::Github, "github.com", "token")
            .await
            .unwrap();
        harness
            .service
            .sign_in_with_token(HostingProvider::Gitlab, "gitlab.com", "lab")
            .await
            .unwrap();
        harness
            .profiles
            .set("token", Err(ProfileError::TokenRejected));
        harness
            .profiles
            .set("lab", Err(ProfileError::TokenRejected));

        harness.service.authentication_failed(
            "git push origin\nremote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/octo/repo.git/'",
        );
        let service = harness.service.clone();
        let mut states = HashMap::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                states = service
                    .list()
                    .await
                    .unwrap()
                    .accounts
                    .into_iter()
                    .map(|account| (account.account_id, account.state))
                    .collect();
                if states[&github.account_id] == AccountState::NeedsReauth {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("the GitHub account was never re-checked");
        // Only the host Git named is re-checked.
        assert_eq!(
            states
                .values()
                .filter(|state| **state == AccountState::Active)
                .count(),
            1
        );
    }

    #[test]
    fn finds_the_hosts_in_git_output() {
        assert_eq!(
            https_hosts(
                "fatal: Authentication failed for 'https://GitHub.com/a/b.git/'\nremote: see https://user@gitlab.com:8443/help and https://github.com/x"
            ),
            vec!["github.com".to_string(), "gitlab.com:8443".to_string()]
        );
        assert!(https_hosts("fatal: could not read Username for 'http://insecure'").is_empty());
    }

    #[tokio::test]
    async fn signing_out_of_a_gitlab_browser_sign_in_revokes_its_tokens() {
        let harness = harness_with_apps(gitlab_apps());
        let account = browser_sign_in(&harness, "access-1", "refresh-1", 7200).await;
        harness.service.sign_out(&account.account_id).await.unwrap();
        assert!(harness.secrets.get(&account.account_id).unwrap().is_none());
        let profiles = harness.profiles.clone();
        eventually(move || profiles.revoked.lock().unwrap().len() == 2).await;
        assert_eq!(
            *harness.profiles.revoked.lock().unwrap(),
            vec!["access-1".to_string(), "refresh-1".to_string()]
        );
    }
}
