use std::{path::Path, process::Stdio, time::Duration};

use tokio::process::Command;

use super::dto::SigningConfig;

const CONFIG_TIMEOUT: Duration = Duration::from_secs(10);
/// A passphrase prompt can be answered by a person, so the test waits longer than a normal Git call.
const TEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_VALUE_CHARS: usize = 300;
const MAX_OUTPUT_CHARS: usize = 2000;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SigningError {
    GitUnavailable,
    Failed,
}

fn clean(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}

async fn config_value(repository_path: &Path, key: &str) -> Result<Option<String>, SigningError> {
    let output = tokio::time::timeout(
        CONFIG_TIMEOUT,
        Command::new("git")
            .arg("-C")
            .arg(repository_path)
            .args(["config", "--get", key])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| SigningError::Failed)?
    .map_err(|_| SigningError::GitUnavailable)?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = clean(&String::from_utf8_lossy(&output.stdout), MAX_VALUE_CHARS);
    Ok((!value.is_empty()).then_some(value))
}

/// Git treats the value as a boolean in several spellings.
pub(super) fn is_true(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "true" | "yes" | "on" | "1"
    )
}

pub(super) fn normalize_format(value: Option<&str>) -> &'static str {
    match value.map(str::to_ascii_lowercase).as_deref() {
        Some("ssh") => "ssh",
        Some("x509") => "x509",
        _ => "openpgp",
    }
}

pub(super) async fn read_config(
    repository_path: &Path,
    repo_id: String,
) -> Result<SigningConfig, SigningError> {
    let format = normalize_format(
        config_value(repository_path, "gpg.format")
            .await?
            .as_deref(),
    );
    let program_key = match format {
        "ssh" => "gpg.ssh.program",
        "x509" => "gpg.x509.program",
        _ => "gpg.program",
    };
    Ok(SigningConfig {
        repo_id,
        format: format.to_owned(),
        signing_key: config_value(repository_path, "user.signingkey").await?,
        sign_by_default: config_value(repository_path, "commit.gpgsign")
            .await?
            .is_some_and(|value| is_true(&value)),
        program: config_value(repository_path, program_key).await?,
    })
}

/// Signs a throwaway commit of the empty tree with the configured key. Git makes the signature and
/// no private key reaches this process; no branch or tag moves. The unreachable commit object it
/// writes is removed by Git's normal clean-up.
pub(super) async fn test_signing(repository_path: &Path) -> Result<(bool, String), SigningError> {
    let tree = tokio::time::timeout(
        CONFIG_TIMEOUT,
        Command::new("git")
            .arg("-C")
            .arg(repository_path)
            .args(["mktree"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| SigningError::Failed)?
    .map_err(|_| SigningError::GitUnavailable)?;
    let tree_id = String::from_utf8_lossy(&tree.stdout).trim().to_owned();
    if !tree.status.success() || tree_id.is_empty() {
        return Err(SigningError::Failed);
    }
    let output = tokio::time::timeout(
        TEST_TIMEOUT,
        Command::new("git")
            .arg("-C")
            .arg(repository_path)
            .args(["commit-tree", "-S", "-m", "GitCrest signing test", &tree_id])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .env("GIT_TERMINAL_PROMPT", "0")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err(SigningError::GitUnavailable),
        Err(_) => {
            return Ok((
                false,
                "Signing did not finish within 60 seconds. A passphrase prompt may be waiting."
                    .to_owned(),
            ))
        }
    };
    if output.status.success() {
        return Ok((true, String::new()));
    }
    Ok((
        false,
        clean(&String::from_utf8_lossy(&output.stderr), MAX_OUTPUT_CHARS),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_git_booleans_and_formats() {
        for yes in ["true", "TRUE", "yes", "on", "1"] {
            assert!(is_true(yes), "{yes}");
        }
        for no in ["false", "no", "off", "0", "", "maybe"] {
            assert!(!is_true(no), "{no}");
        }
        assert_eq!(normalize_format(Some("ssh")), "ssh");
        assert_eq!(normalize_format(Some("X509")), "x509");
        assert_eq!(normalize_format(Some("openpgp")), "openpgp");
        assert_eq!(normalize_format(None), "openpgp");
        assert_eq!(normalize_format(Some("unknown")), "openpgp");
    }

    #[test]
    fn shortens_values_and_drops_control_characters() {
        assert_eq!(clean("a\u{7}b\n", 10), "ab");
        assert_eq!(clean(&"x".repeat(500), 300).len(), 300);
    }
}
