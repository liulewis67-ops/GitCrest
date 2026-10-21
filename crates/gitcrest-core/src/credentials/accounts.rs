use std::sync::{Arc, RwLock};

#[cfg(test)]
use std::{collections::HashMap, sync::Mutex};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::CredentialError;

/// Environment variable the core sets on Git network commands so the askpass process knows which
/// signed-in account answers for each host. Values are `host=account-id` pairs joined by `;`.
pub const ASKPASS_ACCOUNTS_ENV: &str = "GITCREST_ASKPASS_ACCOUNTS";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSecret {
    pub git_username: String,
    pub token: Zeroizing<String>,
}

pub trait AccountSecretStore: Send + Sync {
    fn get(&self, account_id: &str) -> Result<Option<AccountSecret>, CredentialError>;
    fn set(&self, account_id: &str, secret: &AccountSecret) -> Result<(), CredentialError>;
    fn delete(&self, account_id: &str) -> Result<(), CredentialError>;
}

pub fn system_account_secret_store() -> Arc<dyn AccountSecretStore> {
    Arc::new(super::keyring::SystemAccountSecretStore)
}

/// The account currently selected for each host, shared between the accounts feature (which
/// writes it) and Git command execution (which hands it to askpass).
#[derive(Clone, Debug, Default)]
pub struct AccountSelections(Arc<RwLock<Vec<(String, String)>>>);

impl AccountSelections {
    pub fn replace(&self, selections: Vec<(String, String)>) {
        if let Ok(mut current) = self.0.write() {
            *current = selections;
        }
    }

    pub fn hosts(&self) -> Vec<String> {
        self.0
            .read()
            .map(|current| current.iter().map(|(host, _)| host.clone()).collect())
            .unwrap_or_default()
    }

    pub fn env_value(&self) -> Option<String> {
        let current = self.0.read().ok()?;
        if current.is_empty() {
            return None;
        }
        Some(
            current
                .iter()
                .map(|(host, account_id)| format!("{host}={account_id}"))
                .collect::<Vec<_>>()
                .join(";"),
        )
    }
}

pub fn is_valid_account_id(value: &str) -> bool {
    value.strip_prefix("acct_").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

pub(super) fn selected_account_for_host<'a>(selections: &'a str, host: &str) -> Option<&'a str> {
    selections.split(';').find_map(|pair| {
        let (selected_host, account_id) = pair.split_once('=')?;
        (selected_host == host && is_valid_account_id(account_id)).then_some(account_id)
    })
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryAccountSecretStore {
    values: Mutex<HashMap<String, AccountSecret>>,
}

#[cfg(test)]
impl AccountSecretStore for MemoryAccountSecretStore {
    fn get(&self, account_id: &str) -> Result<Option<AccountSecret>, CredentialError> {
        Ok(self
            .values
            .lock()
            .map_err(|_| CredentialError::Unavailable)?
            .get(account_id)
            .cloned())
    }

    fn set(&self, account_id: &str, secret: &AccountSecret) -> Result<(), CredentialError> {
        self.values
            .lock()
            .map_err(|_| CredentialError::Unavailable)?
            .insert(account_id.to_owned(), secret.clone());
        Ok(())
    }

    fn delete(&self, account_id: &str) -> Result<(), CredentialError> {
        self.values
            .lock()
            .map_err(|_| CredentialError::Unavailable)?
            .remove(account_id);
        Ok(())
    }
}
