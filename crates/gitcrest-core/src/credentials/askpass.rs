use zeroize::Zeroizing;

use super::{normalize_host, CredentialError, CredentialManager};

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
    answer_askpass_prompt_with_manager(prompt, &CredentialManager::system())
}

pub(super) fn answer_askpass_prompt_with_manager(
    prompt: &str,
    manager: &CredentialManager,
) -> Result<Zeroizing<String>, CredentialError> {
    let (kind, host) = parse_askpass_prompt(prompt)?;
    let credential = manager
        .get_for_git(&host)?
        .ok_or(CredentialError::Unavailable)?;
    Ok(match kind {
        AskpassPromptKind::Username => Zeroizing::new(credential.username),
        AskpassPromptKind::Password => credential.token,
    })
}
