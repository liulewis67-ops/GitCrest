use std::{path::Path, process::Stdio, time::Duration};

use tokio::process::Command;

use super::dto::GitIdentity;

const CONFIG_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FIELD_LENGTH: usize = 256;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IdentityError {
    Invalid,
    GitUnavailable,
    Failed,
}

#[derive(Clone, Copy)]
pub(super) enum Scope {
    Global,
    Local,
}

impl Scope {
    fn flag(self) -> &'static str {
        match self {
            Scope::Global => "--global",
            Scope::Local => "--local",
        }
    }
}

fn validate_field(value: &str, require_at: bool) -> Result<String, IdentityError> {
    let value = value.trim();
    let bad = value.is_empty()
        || value.chars().count() > MAX_FIELD_LENGTH
        || value
            .chars()
            .any(|character| character.is_control() || character == '<' || character == '>');
    if bad || (require_at && !value.contains('@')) {
        return Err(IdentityError::Invalid);
    }
    Ok(value.to_owned())
}

async fn run_git(
    repository_path: Option<&Path>,
    arguments: &[&str],
) -> Result<(bool, String), IdentityError> {
    let mut command = Command::new("git");
    if let Some(path) = repository_path {
        command.arg("-C").arg(path);
    }
    let output = command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(CONFIG_TIMEOUT, output).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err(IdentityError::GitUnavailable),
        Err(_) => return Err(IdentityError::Failed),
    };
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    ))
}

/// Reads one key as `scope<TAB>value`; an unset key is not an error.
async fn read_key(
    repository_path: Option<&Path>,
    key: &str,
    only: Option<Scope>,
) -> Result<Option<(String, String)>, IdentityError> {
    let mut arguments = vec!["config", "--show-scope"];
    if let Some(scope) = only {
        arguments.push(scope.flag());
    }
    arguments.extend(["--get", key]);
    let (success, stdout) = run_git(repository_path, &arguments).await?;
    if !success {
        return Ok(None);
    }
    let line = stdout.lines().next().unwrap_or_default();
    Ok(line.split_once('\t').and_then(|(scope, value)| {
        let value = value.trim();
        (!value.is_empty()).then(|| (scope.to_owned(), value.to_owned()))
    }))
}

/// With a repository the effective values are read (local overrides global); without one, only
/// the global values.
pub(super) async fn read(repository_path: Option<&Path>) -> Result<GitIdentity, IdentityError> {
    let only = repository_path.is_none().then_some(Scope::Global);
    let name = read_key(repository_path, "user.name", only).await?;
    let email = read_key(repository_path, "user.email", only).await?;
    Ok(GitIdentity {
        resolved: name.is_some() && email.is_some(),
        name_scope: name.as_ref().map(|(scope, _)| scope.clone()),
        email_scope: email.as_ref().map(|(scope, _)| scope.clone()),
        name: name.map(|(_, value)| value),
        email: email.map(|(_, value)| value),
    })
}

pub(super) async fn write(
    repository_path: Option<&Path>,
    scope: Scope,
    name: &str,
    email: &str,
) -> Result<(), IdentityError> {
    let name = validate_field(name, false)?;
    let email = validate_field(email, true)?;
    for (key, value) in [("user.name", &name), ("user.email", &email)] {
        let (success, _) = run_git(repository_path, &["config", scope.flag(), key, value]).await?;
        if !success {
            return Err(IdentityError::Failed);
        }
    }
    Ok(())
}

/// Removes a repository's own identity so the global one applies again.
pub(super) async fn clear_local(repository_path: &Path) -> Result<(), IdentityError> {
    for key in ["user.name", "user.email"] {
        // Exit code 5 means the key was not set, which is already the wanted state.
        run_git(
            Some(repository_path),
            &["config", "--local", "--unset-all", key],
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_control_and_bracket_values() {
        assert!(validate_field("  ", false).is_err());
        assert!(validate_field("a\nb", false).is_err());
        assert!(validate_field("Ada <x>", false).is_err());
        assert!(validate_field("no-at-sign", true).is_err());
        assert_eq!(validate_field(" Ada ", false).unwrap(), "Ada");
        assert_eq!(
            validate_field("ada@example.test", true).unwrap(),
            "ada@example.test"
        );
    }
}
