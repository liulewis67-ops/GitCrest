use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::providers::{api_base_url, HostingProfile, HostingProfileClient, ProfileError};
use crate::{
    credentials::{
        normalize_host, AccountSecret, AccountSecretStore, AccountSelections, CredentialError,
    },
    domain::{
        account::{AccountAuthKind, AccountState, HostingAccount, HostingProvider},
        time::unix_time_ms,
    },
    ports::accounts::HostingAccountStorePort,
};

const MAX_TOKEN_BYTES: usize = 64 * 1024;

static NEXT_ACCOUNT_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccountError {
    InvalidInput,
    NotFound,
    TokenRejected,
    ProviderUnreachable,
    StorageUnavailable,
    CredentialsUnavailable,
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
pub(crate) struct AccountList {
    pub(crate) accounts: Vec<AccountSummary>,
}

#[derive(Clone)]
pub(crate) struct AccountService {
    store: Arc<dyn HostingAccountStorePort>,
    secrets: Arc<dyn AccountSecretStore>,
    profiles: Arc<dyn HostingProfileClient>,
    selections: AccountSelections,
    /// Serializes sign-in, switching and sign-out so the keyring, the database and the askpass
    /// selection cache move together.
    mutation: Arc<tokio::sync::Mutex<()>>,
}

impl AccountService {
    pub(crate) fn new(
        store: Arc<dyn HostingAccountStorePort>,
        secrets: Arc<dyn AccountSecretStore>,
        profiles: Arc<dyn HostingProfileClient>,
        selections: AccountSelections,
    ) -> Self {
        if let Ok(current) = store.list_hosting_account_selections() {
            selections.replace(current);
        }
        Self {
            store,
            secrets,
            profiles,
            selections,
            mutation: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub(crate) async fn list(&self) -> Result<AccountList, AccountError> {
        let store = self.store.clone();
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
            .profiles
            .fetch_profile(provider, &api_base_url, &token)
            .await?;

        let _guard = self.mutation.lock().await;
        let store = self.store.clone();
        let secrets = self.secrets.clone();
        let selections = self.selections.clone();
        blocking(move || {
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
                    .map_or_else(new_account_id, |account| account.account_id.clone()),
                provider,
                host: host.clone(),
                api_base_url,
                remote_user_id: profile.remote_user_id.clone(),
                login: profile.login.clone(),
                display_name: profile.display_name.clone(),
                avatar_url: profile.avatar_url.clone(),
                auth_kind: AccountAuthKind::Token,
                scopes: profile.scopes.clone().unwrap_or_default(),
                token_expires_at_ms: profile.token_expires_at_ms,
                state: AccountState::Active,
                created_at_ms: existing
                    .as_ref()
                    .map_or(now, |account| account.created_at_ms),
                last_validated_at_ms: now,
            };
            secrets.set(
                &account.account_id,
                &AccountSecret {
                    git_username: account.login.clone(),
                    token,
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
        .await
    }

    /// Makes this account the one Git uses for its host.
    pub(crate) async fn select(&self, account_id: &str) -> Result<AccountSummary, AccountError> {
        let _guard = self.mutation.lock().await;
        let store = self.store.clone();
        let selections = self.selections.clone();
        let account_id = account_id.to_owned();
        blocking(move || {
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
        .await
    }

    /// Checks the stored token with the provider and refreshes the profile. A rejected or missing
    /// token marks the account as needing sign-in instead of failing the request.
    pub(crate) async fn validate(&self, account_id: &str) -> Result<AccountSummary, AccountError> {
        let store = self.store.clone();
        let secrets = self.secrets.clone();
        let lookup_id = account_id.to_owned();
        let (account, secret) = blocking(move || {
            let account = find_account(store.as_ref(), &lookup_id)?;
            let secret = secrets.get(&account.account_id)?;
            Ok((account, secret))
        })
        .await?;
        let outcome = match &secret {
            Some(secret) => match self
                .profiles
                .fetch_profile(account.provider, &account.api_base_url, &secret.token)
                .await
            {
                Ok(profile) if profile.remote_user_id == account.remote_user_id => Some(profile),
                Ok(_) | Err(ProfileError::TokenRejected) => None,
                Err(ProfileError::ProviderUnreachable) => {
                    return Err(AccountError::ProviderUnreachable)
                }
            },
            None => None,
        };

        let _guard = self.mutation.lock().await;
        let store = self.store.clone();
        let account_id = account_id.to_owned();
        blocking(move || {
            // The account may have been signed out or replaced while the provider answered.
            let mut current = find_account(store.as_ref(), &account_id)?;
            apply_validation(&mut current, outcome.as_ref(), unix_time_ms());
            store
                .save_hosting_account(&current)
                .map_err(|_| AccountError::StorageUnavailable)?;
            let selections = store
                .list_hosting_account_selections()
                .map_err(|_| AccountError::StorageUnavailable)?;
            Ok(summary(current, &selections))
        })
        .await
    }

    /// Forgets the account and its token. When it was the account Git used for its host, another
    /// account on that host takes over, preferring one whose token still works.
    pub(crate) async fn sign_out(&self, account_id: &str) -> Result<(), AccountError> {
        let _guard = self.mutation.lock().await;
        let store = self.store.clone();
        let secrets = self.secrets.clone();
        let selections = self.selections.clone();
        let account_id = account_id.to_owned();
        blocking(move || {
            let account = find_account(store.as_ref(), &account_id)?;
            let was_selected = store
                .list_hosting_account_selections()
                .map_err(|_| AccountError::StorageUnavailable)?
                .iter()
                .any(|(_, selected)| *selected == account.account_id);
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
            Ok(())
        })
        .await
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
    account.token_expires_at_ms = profile.token_expires_at_ms;
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

fn new_account_id() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(NEXT_ACCOUNT_ID.fetch_add(1, Ordering::Relaxed));
    let mut digest = Sha256::new();
    digest.update(hasher.finish().to_le_bytes());
    digest.update(unix_time_ms().to_le_bytes());
    digest.update(std::process::id().to_le_bytes());
    let bytes = digest.finalize();
    let suffix: String = bytes[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("acct_{suffix}")
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use super::*;
    use crate::{
        credentials::{is_valid_account_id, MemoryAccountSecretStore},
        features::accounts::providers::ProfileFuture,
        storage::RepositoryStore,
    };

    /// Answers profile requests from a token → profile table; unknown tokens are rejected.
    #[derive(Default)]
    struct FakeProfiles {
        profiles: Mutex<HashMap<String, Result<HostingProfile, ProfileError>>>,
    }

    impl FakeProfiles {
        fn set(&self, token: &str, profile: Result<HostingProfile, ProfileError>) {
            self.profiles
                .lock()
                .unwrap()
                .insert(token.to_owned(), profile);
        }
    }

    impl HostingProfileClient for FakeProfiles {
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
        let secrets = Arc::new(MemoryAccountSecretStore::default());
        let profiles = Arc::new(FakeProfiles::default());
        let selections = AccountSelections::default();
        let service = AccountService::new(
            Arc::new(RepositoryStore::default()),
            secrets.clone(),
            profiles.clone(),
            selections.clone(),
        );
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
}
