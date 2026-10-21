use zeroize::Zeroizing;

use super::{
    accounts::selected_account_for_host, normalize_host, system_account_secret_store,
    AccountSecretStore, CredentialError, CredentialManager, ASKPASS_ACCOUNTS_ENV,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskpassPromptKind {
    Username,
    Password,
}

pub fn parse_askpass_prompt(prompt: &str) -> Result<(AskpassPromptKind, String), CredentialError> {
    let (kind, remainder) = if let Some(remainder) = prompt.strip_prefix("Username for '") {
        (AskpassPromptKind::Username, remainder)
    } else if let Some(remainder) = prompt.strip_prefix("Password for '") {
        (AskpassPromptKind::Password, remainder)
    } else {
        return Err(CredentialError::InvalidInput);
    };
    let end = remainder.find('\'').ok_or(CredentialError::InvalidInput)?;
    let url = &remainder[..end];
    let authority = url
        .strip_prefix("https://")
        .ok_or(CredentialError::InvalidInput)?
        .split('/')
        .next()
        .ok_or(CredentialError::InvalidInput)?;
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    Ok((kind, normalize_host(host)?))
}

pub fn answer_askpass_prompt(prompt: &str) -> Result<Zeroizing<String>, CredentialError> {
    let selections = std::env::var(ASKPASS_ACCOUNTS_ENV).unwrap_or_default();
    answer_askpass_prompt_with_stores(
        prompt,
        &selections,
        Some(system_account_secret_store().as_ref()),
        &CredentialManager::system(),
    )
}

#[cfg(test)]
pub(super) fn answer_askpass_prompt_with_manager(
    prompt: &str,
    manager: &CredentialManager,
) -> Result<Zeroizing<String>, CredentialError> {
    answer_askpass_prompt_with_stores(prompt, "", None, manager)
}

/// A signed-in account selected for the prompt's host answers first; the per-host HTTPS
/// credential remains the fallback for hosts without one.
pub(super) fn answer_askpass_prompt_with_stores(
    prompt: &str,
    selections: &str,
    accounts: Option<&dyn AccountSecretStore>,
    manager: &CredentialManager,
) -> Result<Zeroizing<String>, CredentialError> {
    let (kind, host) = parse_askpass_prompt(prompt)?;
    if let (Some(account_id), Some(accounts)) =
        (selected_account_for_host(selections, &host), accounts)
    {
        if let Some(secret) = accounts.get(account_id)? {
            return Ok(match kind {
                AskpassPromptKind::Username => Zeroizing::new(secret.git_username),
                AskpassPromptKind::Password => secret.token,
            });
        }
    }
    let credential = manager
        .get_for_git(&host)?
        .ok_or(CredentialError::Unavailable)?;
    Ok(match kind {
        AskpassPromptKind::Username => Zeroizing::new(credential.username),
        AskpassPromptKind::Password => credential.token,
    })
}
