use std::{path::Path, process::Stdio, time::Duration};

use tokio::process::Command;

use super::dto::{BackupRef, ReflogEntry};

pub(super) const DEFAULT_LIMIT: usize = 100;
pub(super) const MAX_LIMIT: usize = 500;
const GIT_TIMEOUT: Duration = Duration::from_secs(15);
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReflogError {
    /// The reference is not `HEAD` or a plain local branch name.
    InvalidRef,
    /// The branch has no reflog (it does not exist, or reflogs are off for it).
    NotFound,
    TooLarge,
    GitUnavailable,
    Failed,
}

/// `HEAD` or `refs/heads/<name>`, with nothing Git or a shell could read as more.
pub(super) fn validate_ref(reference: &str) -> Result<(), ReflogError> {
    if reference == "HEAD" {
        return Ok(());
    }
    let Some(name) = reference.strip_prefix("refs/heads/") else {
        return Err(ReflogError::InvalidRef);
    };
    let bad = name.is_empty()
        || reference.len() > 255
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("//")
        || name.contains("@{")
        || name.chars().any(|character| {
            character.is_control() || character.is_whitespace() || "~^:?*[\\".contains(character)
        });
    if bad {
        Err(ReflogError::InvalidRef)
    } else {
        Ok(())
    }
}

async fn git(repository_path: &Path, arguments: &[String]) -> Result<(bool, Vec<u8>), ReflogError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository_path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(GIT_TIMEOUT, output).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err(ReflogError::GitUnavailable),
        Err(_) => return Err(ReflogError::Failed),
    };
    if output.stdout.len() > OUTPUT_LIMIT {
        return Err(ReflogError::TooLarge);
    }
    Ok((output.status.success(), output.stdout))
}

pub(super) fn parse_entry(index: usize, line: &str) -> Option<ReflogEntry> {
    let mut parts = line.splitn(4, '\t');
    let oid = parts.next()?;
    let selector = parts.next()?;
    let created = parts.next()?;
    let message = parts.next().unwrap_or_default();
    (!oid.is_empty()).then(|| ReflogEntry {
        index,
        oid: oid.to_owned(),
        selector: selector.to_owned(),
        message: message.to_owned(),
        created_at_ms: created.parse::<i64>().unwrap_or(0) * 1000,
    })
}

/// One page of a reference's reflog, plus whether more follows.
pub(super) async fn read_page(
    repository_path: &Path,
    reference: &str,
    offset: usize,
    limit: usize,
) -> Result<(Vec<ReflogEntry>, bool), ReflogError> {
    validate_ref(reference)?;
    // One extra row says whether another page exists.
    let arguments = vec![
        "reflog".to_owned(),
        "show".to_owned(),
        "--format=%H%x09%gd%x09%ct%x09%gs".to_owned(),
        format!("--skip={offset}"),
        format!("-n{}", limit + 1),
        reference.to_owned(),
        "--".to_owned(),
    ];
    let (success, output) = git(repository_path, &arguments).await?;
    if !success {
        // A branch that was never moved has no reflog, which is not worth an error when HEAD is asked.
        return if reference == "HEAD" {
            Ok((Vec::new(), false))
        } else {
            Err(ReflogError::NotFound)
        };
    }
    let text = String::from_utf8_lossy(&output);
    let mut entries: Vec<ReflogEntry> = text
        .lines()
        .enumerate()
        .filter_map(|(position, line)| parse_entry(offset + position, line))
        .collect();
    let more = entries.len() > limit;
    entries.truncate(limit);
    Ok((entries, more))
}

fn parse_backup(line: &str) -> Option<BackupRef> {
    let mut parts = line.splitn(4, '\t');
    let reference = parts.next()?;
    let oid = parts.next()?;
    let created = parts.next()?;
    let subject = parts.next().unwrap_or_default();
    let kind = if reference.starts_with("refs/gitcrest/rebase-backups/") {
        "rebase"
    } else if reference.starts_with("refs/gitcrest/reset-backups/") {
        "reset"
    } else {
        return None;
    };
    Some(BackupRef {
        reference: reference.to_owned(),
        oid: oid.to_owned(),
        kind: kind.to_owned(),
        subject: subject.to_owned(),
        created_at_ms: created.parse::<i64>().unwrap_or(0) * 1000,
    })
}

/// The refs GitCrest saved before rebases and resets, newest first.
pub(super) async fn read_backups(repository_path: &Path) -> Result<Vec<BackupRef>, ReflogError> {
    let arguments = vec![
        "for-each-ref".to_owned(),
        "--sort=-creatordate".to_owned(),
        "--format=%(refname)%09%(objectname)%09%(creatordate:unix)%09%(contents:subject)"
            .to_owned(),
        "--count=200".to_owned(),
        "refs/gitcrest/rebase-backups".to_owned(),
        "refs/gitcrest/reset-backups".to_owned(),
    ];
    let (success, output) = git(repository_path, &arguments).await?;
    if !success {
        return Err(ReflogError::Failed);
    }
    Ok(String::from_utf8_lossy(&output)
        .lines()
        .filter_map(parse_backup)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_head_and_plain_local_branches_only() {
        for good in ["HEAD", "refs/heads/main", "refs/heads/feature/x-1"] {
            assert!(validate_ref(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "main",
            "refs/remotes/origin/main",
            "refs/heads/",
            "refs/heads/-x",
            "refs/heads/a..b",
            "refs/heads/a b",
            "refs/heads/a@{1}",
            "refs/heads/a.lock",
            "refs/heads/a~1",
            "refs/tags/v1",
            "HEAD@{1}",
            "--all",
        ] {
            assert_eq!(validate_ref(bad), Err(ReflogError::InvalidRef), "{bad}");
        }
    }

    #[test]
    fn parses_an_entry_and_keeps_tabs_in_the_message() {
        let entry = parse_entry(3, "abc\tHEAD@{3}\t100\tcommit: a\tb").unwrap();
        assert_eq!(entry.index, 3);
        assert_eq!(entry.selector, "HEAD@{3}");
        assert_eq!(entry.message, "commit: a\tb");
        assert_eq!(entry.created_at_ms, 100_000);
    }

    #[test]
    fn labels_backups_by_namespace() {
        assert_eq!(
            parse_backup("refs/gitcrest/reset-backups/t1\tabc\t5\tsubject")
                .unwrap()
                .kind,
            "reset"
        );
        assert_eq!(
            parse_backup("refs/gitcrest/rebase-backups/t2\tabc\t5\ts")
                .unwrap()
                .kind,
            "rebase"
        );
        assert!(parse_backup("refs/gitcrest/other/t3\tabc\t5\ts").is_none());
    }
}
