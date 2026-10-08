use std::{path::Path, process::Stdio, time::Duration};

use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const MAX_BRANCH_OUTPUT: usize = 8 * 1024 * 1024;
const GIT_READ_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSnapshot {
    pub repo_id: String,
    pub current: Option<String>,
    pub detached: bool,
    pub branches: Vec<BranchRef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRef {
    pub name: String,
    pub full_name: String,
    pub oid: String,
    pub kind: BranchKind,
    pub is_current: bool,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub is_favorite: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BranchKind {
    Local,
    Remote,
}

#[derive(Debug, PartialEq, Eq)]
pub enum BranchError {
    InvalidName,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
}

pub async fn validate_branch_name(repository_path: &Path, name: &str) -> Result<(), BranchError> {
    if name.is_empty() || name.len() > 255 || name.chars().any(char::is_control) {
        return Err(BranchError::InvalidName);
    }
    match run_git(
        repository_path,
        &["check-ref-format".into(), "--branch".into(), name.into()],
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(BranchError::GitFailed) => Err(BranchError::InvalidName),
        Err(error) => Err(error),
    }
}

pub async fn unmerged_commit_count(
    repository_path: &Path,
    current: &str,
    branch: &str,
) -> Result<u32, BranchError> {
    let current_ref = if current.starts_with("refs/") || current.len() == 40 || current.len() == 64
    {
        current.to_owned()
    } else {
        format!("refs/heads/{current}")
    };
    let branch_ref = format!("refs/heads/{branch}");
    let output = run_git(
        repository_path,
        &[
            "rev-list".into(),
            "--count".into(),
            format!("{current_ref}..{branch_ref}").into(),
        ],
    )
    .await?;
    std::str::from_utf8(&output)
        .map_err(|_| BranchError::GitFailed)?
        .trim()
        .parse::<u32>()
        .map_err(|_| BranchError::GitFailed)
}

pub async fn paths_changed_between(
    repository_path: &Path,
    current: &str,
    target: &str,
) -> Result<Vec<String>, BranchError> {
    let current_ref = if current.starts_with("refs/") || current.len() == 40 || current.len() == 64
    {
        current.to_owned()
    } else {
        format!("refs/heads/{current}")
    };
    let target_ref = format!("refs/heads/{target}");
    let output = run_git(
        repository_path,
        &[
            "diff".into(),
            "--name-only".into(),
            "-z".into(),
            current_ref.into(),
            target_ref.into(),
        ],
    )
    .await?;
    Ok(output
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect())
}

pub async fn read_branches(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
) -> Result<BranchSnapshot, BranchError> {
    let output = run_git(
        repository_path,
        &[
            "for-each-ref".into(),
            "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)".into(),
            "refs/heads".into(),
            "refs/remotes".into(),
        ],
    )
    .await?;
    let mut branches = Vec::new();
    for record in output
        .split(|byte| *byte == b'\n')
        .filter(|record| !record.is_empty())
    {
        let fields = record.splitn(5, |byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() != 5 {
            return Err(BranchError::GitFailed);
        }
        let full_name = String::from_utf8_lossy(fields[0]).into_owned();
        let name = String::from_utf8_lossy(fields[1]).into_owned();
        let oid = String::from_utf8_lossy(fields[2]).into_owned();
        let upstream = nonempty(fields[3]);
        let track = String::from_utf8_lossy(fields[4]);
        let (mut ahead, mut behind, upstream_gone) = parse_track(&track)?;
        if upstream.is_some() && !upstream_gone && ahead.is_none() && behind.is_none() {
            ahead = Some(0);
            behind = Some(0);
        }
        let kind = if full_name.starts_with("refs/heads/") {
            BranchKind::Local
        } else if full_name.starts_with("refs/remotes/") {
            BranchKind::Remote
        } else {
            return Err(BranchError::GitFailed);
        };
        let is_current = matches!(kind, BranchKind::Local) && current == Some(name.as_str());
        branches.push(BranchRef {
            name,
            full_name,
            oid,
            kind,
            is_current,
            upstream,
            upstream_gone,
            ahead,
            behind,
            is_favorite: false,
        });
    }
    Ok(BranchSnapshot {
        repo_id,
        current: current.map(str::to_owned),
        detached,
        branches,
    })
}

fn nonempty(value: &[u8]) -> Option<String> {
    (!value.is_empty()).then(|| String::from_utf8_lossy(value).into_owned())
}

fn parse_track(value: &str) -> Result<(Option<u32>, Option<u32>, bool), BranchError> {
    if value.is_empty() {
        return Ok((None, None, false));
    }
    let value = value.trim();
    if value == "[gone]" {
        return Ok((None, None, true));
    }
    let value = value
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .ok_or(BranchError::GitFailed)?;
    let mut ahead = None;
    let mut behind = None;
    for item in value.split(", ") {
        let Some((direction, count)) = item.split_once(' ') else {
            return Err(BranchError::GitFailed);
        };
        let count = count.parse::<u32>().map_err(|_| BranchError::GitFailed)?;
        match direction {
            "ahead" => ahead = Some(count),
            "behind" => behind = Some(count),
            _ => return Err(BranchError::GitFailed),
        }
    }
    Ok((Some(ahead.unwrap_or(0)), Some(behind.unwrap_or(0)), false))
}

async fn run_git(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<Vec<u8>, BranchError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| BranchError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(BranchError::GitFailed)?;
    let stderr = child.stderr.take().ok_or(BranchError::GitFailed)?;
    let stdout_reader = tokio::spawn(read_limited(stdout, MAX_BRANCH_OUTPUT));
    let stderr_reader = tokio::spawn(read_limited(stderr, 16 * 1024));
    let status = match tokio::time::timeout(GIT_READ_DEADLINE, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            let _ = child.kill().await;
            return Err(BranchError::GitFailed);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(BranchError::TimedOut);
        }
    };
    let stdout = stdout_reader
        .await
        .map_err(|_| BranchError::GitFailed)?
        .map_err(|_| BranchError::GitFailed)?;
    let stderr = stderr_reader
        .await
        .map_err(|_| BranchError::GitFailed)?
        .map_err(|_| BranchError::GitFailed)?;
    if stdout.len() > MAX_BRANCH_OUTPUT {
        return Err(BranchError::TooLarge);
    }
    if !status.success() {
        let _ = stderr;
        return Err(BranchError::GitFailed);
    }
    Ok(stdout)
}

async fn read_limited<R>(reader: R, maximum: usize) -> Result<Vec<u8>, std::io::Error>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    reader
        .take(maximum.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, process::Command as StdCommand};

    fn git(path: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    #[tokio::test]
    async fn reads_local_remote_upstream_and_ahead_behind_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("repo");
        std::fs::create_dir(&path).unwrap();
        git(&path, &["init", "--quiet"]);
        git(&path, &["config", "user.name", "Branch Test"]);
        git(&path, &["config", "user.email", "branch@example.invalid"]);
        std::fs::write(path.join("file.txt"), "base\n").unwrap();
        git(&path, &["add", "file.txt"]);
        git(&path, &["commit", "--quiet", "-m", "base"]);
        let default = git(&path, &["branch", "--show-current"]);
        let bare = directory.path().join("origin.git");
        git(
            directory.path(),
            &["init", "--bare", "--quiet", bare.to_str().unwrap()],
        );
        git(&path, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git(&path, &["push", "--quiet", "-u", "origin", &default]);
        git(&path, &["checkout", "--quiet", "-b", "feature/one"]);
        git(&path, &["push", "--quiet", "-u", "origin", "feature/one"]);
        std::fs::write(path.join("file.txt"), "ahead\n").unwrap();
        git(&path, &["commit", "--quiet", "-am", "ahead"]);

        let snapshot = read_branches("repo_fixture".into(), &path, Some("feature/one"), false)
            .await
            .unwrap();
        assert_eq!(snapshot.current.as_deref(), Some("feature/one"));
        let current = snapshot
            .branches
            .iter()
            .find(|branch| branch.is_current)
            .unwrap();
        assert_eq!(current.upstream.as_deref(), Some("origin/feature/one"));
        assert_eq!(current.ahead, Some(1));
        assert_eq!(current.behind, Some(0));
        assert!(snapshot
            .branches
            .iter()
            .any(|branch| matches!(branch.kind, BranchKind::Remote)));
        assert!(snapshot
            .branches
            .iter()
            .any(|branch| branch.name == default && !branch.is_current));
    }

    #[test]
    fn parses_tracking_state_without_assuming_upstream_counts_exist() {
        assert_eq!(
            parse_track("[ahead 2, behind 3]"),
            Ok((Some(2), Some(3), false))
        );
        assert_eq!(parse_track("[ahead 1]"), Ok((Some(1), Some(0), false)));
        assert_eq!(parse_track("[behind 4]"), Ok((Some(0), Some(4), false)));
        assert_eq!(parse_track("[gone]"), Ok((None, None, true)));
        assert_eq!(parse_track(""), Ok((None, None, false)));
    }
}
