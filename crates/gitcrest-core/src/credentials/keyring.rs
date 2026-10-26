use zeroize::Zeroizing;

use super::{AccountSecret, AccountSecretStore, CredentialError, CredentialStore, GitCredential};

const KEYRING_SERVICE: &str = "com.gitcrest.git-https";
const ACCOUNT_KEYRING_SERVICE: &str = "com.gitcrest.hosting-accounts";

pub(super) struct SystemCredentialStore;

pub(super) struct SystemAccountSecretStore;

impl AccountSecretStore for SystemAccountSecretStore {
    fn get(&self, account_id: &str) -> Result<Option<AccountSecret>, CredentialError> {
        let entry = keyring::Entry::new(ACCOUNT_KEYRING_SERVICE, account_id)
            .map_err(|_| CredentialError::Unavailable)?;
        match entry.get_password() {
            Ok(value) => serde_json::from_str(&Zeroizing::new(value))
                .map(Some)
                .map_err(|_| CredentialError::Unavailable),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CredentialError::Unavailable),
        }
    }

    fn set(&self, account_id: &str, secret: &AccountSecret) -> Result<(), CredentialError> {
        let entry = keyring::Entry::new(ACCOUNT_KEYRING_SERVICE, account_id)
            .map_err(|_| CredentialError::Unavailable)?;
        let value = Zeroizing::new(
            serde_json::to_string(secret).map_err(|_| CredentialError::Unavailable)?,
        );
        entry
            .set_password(&value)
            .map_err(|_| CredentialError::Unavailable)
    }

    fn delete(&self, account_id: &str) -> Result<(), CredentialError> {
        let entry = keyring::Entry::new(ACCOUNT_KEYRING_SERVICE, account_id)
            .map_err(|_| CredentialError::Unavailable)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialError::Unavailable),
        }
    }
}

impl CredentialStore for SystemCredentialStore {
    fn get(&self, host: &str) -> Result<Option<GitCredential>, CredentialError> {
        let entry =
            keyring::Entry::new(KEYRING_SERVICE, host).map_err(|_| CredentialError::Unavailable)?;
        match entry.get_password() {
            Ok(value) => serde_json::from_str(&Zeroizing::new(value))
                .map(Some)
                .map_err(|_| CredentialError::Unavailable),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CredentialError::Unavailable),
        }
    }

    fn set(&self, host: &str, credential: &GitCredential) -> Result<(), CredentialError> {
        let entry =
            keyring::Entry::new(KEYRING_SERVICE, host).map_err(|_| CredentialError::Unavailable)?;
        let value = Zeroizing::new(
            serde_json::to_string(credential).map_err(|_| CredentialError::Unavailable)?,
        );
        entry
            .set_password(&value)
            .map_err(|_| CredentialError::Unavailable)
    }

    fn delete(&self, host: &str) -> Result<(), CredentialError> {
        let entry =
            keyring::Entry::new(KEYRING_SERVICE, host).map_err(|_| CredentialError::Unavailable)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialError::Unavailable),
        }
    }
}
