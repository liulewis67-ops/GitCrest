use std::{path::Path, process::Stdio, time::Duration};

use tokio::process::Command;

use super::dto::StashEntry;

const MAX_STASHES: usize = 200;
const LIST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StashError {
    GitUnavailable,
    TimedOut,
    Failed,
}

/// Splits Git's stash subject, `WIP on <branch>: <sha> <subject>` or `On <branch>: <message>`.
fn split_subject(subject: &str) -> (Option<String>, String) {
    for prefix in ["WIP on ", "On ", "index on "] {
        if let Some(rest) = subject.strip_prefix(prefix) {
            if let Some((branch, message)) = rest.split_once(": ") {
                return (Some(branch.to_owned()), message.to_owned());
            }
        }
    }
    (None, subject.to_owned())
}

pub(super) fn parse_line(index: usize, line: &str) -> Option<StashEntry> {
    let mut parts = line.splitn(4, '\t');
    let oid = parts.next()?;
    let parents = parts.next()?;
    let created = parts.next()?;
    let subject = parts.next().unwrap_or_default();
    if oid.is_empty() {
        return None;
    }
    let mut parent_ids = parents.split_whitespace();
    let base_oid = parent_ids.next().map(str::to_owned);
    let _index_commit = parent_ids.next();
    let untracked_oid = parent_ids.next().map(str::to_owned);
    let (branch, message) = split_subject(subject);
    Some(StashEntry {
        index,
        oid: oid.to_owned(),
        base_oid,
        untracked_oid,
        branch,
        message,
        created_at_ms: created.parse::<i64>().unwrap_or(0) * 1000,
    })
}

/// The stash list, newest first. A repository without a stash has an empty list.
pub(super) async fn list(repository_path: &Path) -> Result<Vec<StashEntry>, StashError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository_path)
        .args([
            "reflog",
            "show",
            "--format=%H%x09%P%x09%ct%x09%gs",
            "refs/stash",
            "--",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(LIST_TIMEOUT, output).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err(StashError::GitUnavailable),
        Err(_) => return Err(StashError::TimedOut),
    };
    if !output.status.success() {
        // No refs/stash yet: nothing has been stashed.
        let missing = Command::new("git")
            .arg("-C")
            .arg(repository_path)
            .args(["rev-parse", "--verify", "--quiet", "refs/stash"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map(|status| !status.success())
            .unwrap_or(false);
        return if missing {
            Ok(Vec::new())
        } else {
            Err(StashError::Failed)
        };
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .take(MAX_STASHES)
        .enumerate()
        .filter_map(|(index, line)| parse_line(index, line))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_branch_message_and_the_untracked_commit() {
        let line = "aaa\tbase idx untr\t100\tWIP on main: 1234567 subject";
        let entry = parse_line(0, line).unwrap();
        assert_eq!(entry.branch.as_deref(), Some("main"));
        assert_eq!(entry.message, "1234567 subject");
        assert_eq!(entry.base_oid.as_deref(), Some("base"));
        assert_eq!(entry.untracked_oid.as_deref(), Some("untr"));
        assert_eq!(entry.created_at_ms, 100_000);

        let named = parse_line(2, "bbb\tbase idx\t5\tOn feature/x: before refactor").unwrap();
        assert_eq!(named.branch.as_deref(), Some("feature/x"));
        assert_eq!(named.message, "before refactor");
        assert_eq!(named.untracked_oid, None);
        assert_eq!(
            parse_line(0, "ccc\tp i\t1\tfree text").unwrap().branch,
            None
        );
    }
}
