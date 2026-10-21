use std::sync::Arc;

#[cfg(test)]
use std::{collections::HashMap, sync::Mutex};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

mod accounts;
mod askpass;
mod keyring;

pub use accounts::{
    is_valid_account_id, system_account_secret_store, AccountSecret, AccountSecretStore,
    AccountSelections, ASKPASS_ACCOUNTS_ENV,
};
pub use askpass::answer_askpass_prompt;

#[cfg(test)]
pub use accounts::MemoryAccountSecretStore;

#[cfg(test)]
pub use askpass::{parse_askpass_prompt, AskpassPromptKind};

#[cfg(test)]
use askpass::{answer_askpass_prompt_with_manager, answer_askpass_prompt_with_stores};

const MAX_CREDENTIAL_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub host: String,
    pub username: Option<String>,
    pub is_configured: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct GitCredential {
    pub username: String,
    pub token: Zeroizing<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialError {
    InvalidInput,
    Unavailable,
}

pub trait AiCredentialStore: Send + Sync {
    fn is_configured(&self) -> Result<bool, CredentialError>;
    fn get(&self) -> Result<Option<Zeroizing<String>>, CredentialError>;
    fn set(&self, api_key: &str) -> Result<(), CredentialError>;
    fn delete(&self) -> Result<(), CredentialError>;
}

#[derive(Clone)]
pub struct AiCredentialManager {
    store: Arc<dyn AiCredentialStore>,
}

impl AiCredentialManager {
    pub fn system() -> Self {
        Self {
            store: Arc::new(keyring::SystemAiCredentialStore),
        }
    }

    #[cfg(test)]
    pub fn with_store(store: Arc<dyn AiCredentialStore>) -> Self {
        Self { store }
    }

    pub fn is_configured(&self) -> Result<bool, CredentialError> {
        self.store.is_configured()
    }

    pub fn get(&self) -> Result<Option<Zeroizing<String>>, CredentialError> {
        self.store.get()
    }

    pub fn set(&self, api_key: &str) -> Result<(), CredentialError> {
        if api_key.is_empty()
            || api_key.len() > MAX_CREDENTIAL_BYTES
            || api_key.chars().any(char::is_control)
        {
            return Err(CredentialError::InvalidInput);
        }
        self.store.set(api_key)
    }

    pub fn delete(&self) -> Result<(), CredentialError> {
        self.store.delete()
    }
}

pub trait CredentialStore: Send + Sync {
    fn get(&self, host: &str) -> Result<Option<GitCredential>, CredentialError>;
    fn set(&self, host: &str, credential: &GitCredential) -> Result<(), CredentialError>;
    fn delete(&self, host: &str) -> Result<(), CredentialError>;
}

#[derive(Clone)]
pub struct CredentialManager {
    store: Arc<dyn CredentialStore>,
}

impl CredentialManager {
    pub fn system() -> Self {
        Self {
            store: Arc::new(keyring::SystemCredentialStore),
        }
    }

    #[cfg(test)]
    pub fn with_store(store: Arc<dyn CredentialStore>) -> Self {
        Self { store }
    }

    pub fn status(&self, host: &str) -> Result<CredentialStatus, CredentialError> {
        let host = normalize_host(host)?;
        let credential = self.store.get(&host)?;
        Ok(CredentialStatus {
            host,
            username: credential
                .as_ref()
                .map(|credential| credential.username.clone()),
            is_configured: credential.is_some(),
        })
    }

    pub fn set(
        &self,
        host: &str,
        username: &str,
        token: &str,
    ) -> Result<CredentialStatus, CredentialError> {
        let host = normalize_host(host)?;
        if username.is_empty()
            || username.len() > 255
            || username.chars().any(char::is_control)
            || token.is_empty()
            || token.len() > MAX_CREDENTIAL_BYTES
            || token.chars().any(char::is_control)
        {
            return Err(CredentialError::InvalidInput);
        }
        self.store.set(
            &host,
            &GitCredential {
                username: username.to_owned(),
                token: Zeroizing::new(token.to_owned()),
            },
        )?;
        Ok(CredentialStatus {
            host,
            username: Some(username.to_owned()),
            is_configured: true,
        })
    }

    pub fn delete(&self, host: &str) -> Result<(), CredentialError> {
        self.store.delete(&normalize_host(host)?)
    }

    pub fn get_for_git(&self, host: &str) -> Result<Option<GitCredential>, CredentialError> {
        self.store.get(&normalize_host(host)?)
    }
}

pub fn normalize_host(host: &str) -> Result<String, CredentialError> {
    if host.is_empty()
        || host.len() > 260
        || host.trim() != host
        || host.chars().any(char::is_control)
    {
        return Err(CredentialError::InvalidInput);
    }
    let (host_name, port) = if let Some(address) = host.strip_prefix('[') {
        let (address, suffix) = address
            .split_once(']')
            .ok_or(CredentialError::InvalidInput)?;
        address
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| CredentialError::InvalidInput)?;
        let port = if suffix.is_empty() {
            None
        } else {
            Some(
                suffix
                    .strip_prefix(':')
                    .ok_or(CredentialError::InvalidInput)?
                    .parse::<u16>()
                    .map_err(|_| CredentialError::InvalidInput)?,
            )
        };
        (format!("[{address}]"), port)
    } else {
        let (name, port) = match host.rsplit_once(':') {
            Some((name, port)) if !name.contains(':') => (
                name,
                Some(
                    port.parse::<u16>()
                        .map_err(|_| CredentialError::InvalidInput)?,
                ),
            ),
            Some(_) => return Err(CredentialError::InvalidInput),
            None => (host, None),
        };
        if name.is_empty()
            || name.len() > 253
            || name.split('.').any(|label| {
                label.is_empty()
                    || label.len() > 63
                    || label.starts_with('-')
                    || label.ends_with('-')
                    || !label
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '-')
            })
        {
            return Err(CredentialError::InvalidInput);
        }
        (name.to_ascii_lowercase(), port)
    };
    if port == Some(0) {
        return Err(CredentialError::InvalidInput);
    }
    Ok(match port.filter(|port| *port != 443) {
        Some(port) => format!("{host_name}:{port}"),
        None => host_name,
    })
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryCredentialStore {
    values: Mutex<HashMap<String, GitCredential>>,
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryAiCredentialStore {
    value: Mutex<Option<Zeroizing<String>>>,
}

#[cfg(test)]
impl AiCredentialStore for MemoryAiCredentialStore {
    fn is_configured(&self) -> Result<bool, CredentialError> {
        Ok(self
            .value
            .lock()
            .map_err(|_| CredentialError::Unavailable)?
            .is_some())
    }

    fn get(&self) -> Result<Option<Zeroizing<String>>, CredentialError> {
        Ok(self
            .value
            .lock()
            .map_err(|_| CredentialError::Unavailable)?
            .as_ref()
            .map(|secret| Zeroizing::new(secret.to_string())))
    }

    fn set(&self, api_key: &str) -> Result<(), CredentialError> {
        *self
            .value
            .lock()
            .map_err(|_| CredentialError::Unavailable)? = Some(Zeroizing::new(api_key.to_owned()));
        Ok(())
    }

    fn delete(&self) -> Result<(), CredentialError> {
        *self
            .value
            .lock()
            .map_err(|_| CredentialError::Unavailable)? = None;
        Ok(())
    }
}

#[cfg(test)]
impl CredentialStore for MemoryCredentialStore {
    fn get(&self, host: &str) -> Result<Option<GitCredential>, CredentialError> {
        Ok(self
            .values
            .lock()
            .map_err(|_| CredentialError::Unavailable)?
            .get(host)
            .cloned())
    }

    fn set(&self, host: &str, credential: &GitCredential) -> Result<(), CredentialError> {
        self.values
            .lock()
            .map_err(|_| CredentialError::Unavailable)?
            .insert(host.to_owned(), credential.clone());
        Ok(())
    }

    fn delete(&self, host: &str) -> Result<(), CredentialError> {
        self.values
            .lock()
            .map_err(|_| CredentialError::Unavailable)?
            .remove(host);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> CredentialManager {
        CredentialManager::with_store(Arc::new(MemoryCredentialStore::default()))
    }

    #[test]
    fn normalizes_safe_hosts_and_rejects_url_shaped_or_invalid_hosts() {
        assert_eq!(normalize_host("GitHub.COM").unwrap(), "github.com");
        assert_eq!(normalize_host("github.com:443").unwrap(), "github.com");
        assert_eq!(
            normalize_host("github.com:8443").unwrap(),
            "github.com:8443"
        );
        assert_eq!(
            normalize_host("[2001:db8::1]:8443").unwrap(),
            "[2001:db8::1]:8443"
        );
        for host in [
            "",
            "https://github.com",
            "github.com/path",
            "-bad.example",
            "github.com:0",
            "[not-ipv6]",
        ] {
            assert_eq!(normalize_host(host), Err(CredentialError::InvalidInput));
        }
    }

    #[test]
    fn stores_only_metadata_in_status_and_can_replace_or_delete_credentials() {
        let manager = manager();
        let status = manager.set("GitHub.COM", "lewis", "secret-token").unwrap();
        assert_eq!(status.host, "github.com");
        assert_eq!(status.username.as_deref(), Some("lewis"));
        assert!(status.is_configured);
        assert_eq!(
            manager
                .get_for_git("github.com")
                .unwrap()
                .unwrap()
                .token
                .as_str(),
            "secret-token"
        );
        assert!(manager.status("github.com").unwrap().is_configured);
        manager.delete("github.com").unwrap();
        assert!(!manager.status("github.com").unwrap().is_configured);
    }

    #[test]
    fn rejects_empty_or_control_character_secrets_without_storing_them() {
        let manager = manager();
        assert_eq!(
            manager.set("example.com", "user", ""),
            Err(CredentialError::InvalidInput)
        );
        assert_eq!(
            manager.set("example.com", "user", "secret\nvalue"),
            Err(CredentialError::InvalidInput)
        );
        assert!(!manager.status("example.com").unwrap().is_configured);
    }

    #[test]
    fn parses_git_askpass_https_username_and_password_prompts() {
        assert_eq!(
            parse_askpass_prompt("Username for 'https://github.com/org/repo.git': ").unwrap(),
            (AskpassPromptKind::Username, "github.com".into())
        );
        assert_eq!(
            parse_askpass_prompt("Password for 'https://lewis@GitHub.com:8443/org/repo.git': ")
                .unwrap(),
            (AskpassPromptKind::Password, "github.com:8443".into())
        );
        for prompt in [
            "Password for 'ssh://github.com/org/repo.git': ",
            "Token for 'https://github.com/org/repo.git': ",
            "Password for 'https://github.com:bad/repo': ",
        ] {
            assert_eq!(
                parse_askpass_prompt(prompt),
                Err(CredentialError::InvalidInput)
            );
        }
    }

    #[test]
    fn answers_git_askpass_prompts_from_the_matching_credential_store_entry() {
        let manager = manager();
        manager
            .set("example.com:8443", "git-user", "test-token")
            .unwrap();

        assert_eq!(
            answer_askpass_prompt_with_manager(
                "Username for 'https://example.com:8443/org/repo.git': ",
                &manager,
            )
            .unwrap()
            .as_str(),
            "git-user"
        );
        assert_eq!(
            answer_askpass_prompt_with_manager(
                "Password for 'https://git-user@example.com:8443/org/repo.git': ",
                &manager,
            )
            .unwrap()
            .as_str(),
            "test-token"
        );
        assert_eq!(
            answer_askpass_prompt_with_manager(
                "Password for 'https://other.example.com/org/repo.git': ",
                &manager,
            ),
            Err(CredentialError::Unavailable)
        );
    }

    #[test]
    fn askpass_prefers_the_selected_account_and_falls_back_to_host_credentials() {
        let manager = manager();
        manager
            .set("gitlab.com", "legacy-user", "legacy-token")
            .unwrap();
        let accounts = MemoryAccountSecretStore::default();
        let github_account = format!("acct_{}", "a".repeat(32));
        accounts
            .set(
                &github_account,
                &AccountSecret {
                    git_username: "octocat".into(),
                    token: Zeroizing::new("account-token".into()),
                },
            )
            .unwrap();
        let selections = AccountSelections::default();
        selections.replace(vec![("github.com".into(), github_account.clone())]);
        let selections = selections.env_value().unwrap();

        let answer = |prompt: &str| {
            answer_askpass_prompt_with_stores(prompt, &selections, Some(&accounts), &manager)
        };
        assert_eq!(
            answer("Username for 'https://github.com/org/repo.git': ")
                .unwrap()
                .as_str(),
            "octocat"
        );
        assert_eq!(
            answer("Password for 'https://octocat@github.com/org/repo.git': ")
                .unwrap()
                .as_str(),
            "account-token"
        );
        assert_eq!(
            answer("Password for 'https://gitlab.com/org/repo.git': ")
                .unwrap()
                .as_str(),
            "legacy-token"
        );
        assert_eq!(
            answer("Password for 'https://github.example.com/org/repo.git': "),
            Err(CredentialError::Unavailable)
        );
        assert_eq!(
            answer_askpass_prompt_with_stores(
                "Password for 'https://github.com/org/repo.git': ",
                "github.com=not-an-account-id",
                Some(&accounts),
                &manager,
            ),
            Err(CredentialError::Unavailable)
        );
    }
}
