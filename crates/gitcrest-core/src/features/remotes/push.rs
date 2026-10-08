use std::{path::Path, process::Stdio, time::Duration};

use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const MAX_PUSH_PREVIEW_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_PREVIEW_PATHS: usize = 200;
const MAX_PREVIEW_COMMITS: usize = 50;
const PUSH_PREVIEW_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPreflight {
    pub repo_id: String,
    pub local_branch: String,
    pub remote_name: String,
    pub remote_branch: String,
    pub local_oid: String,
    pub expected_remote_oid: String,
    pub ahead: u32,
    pub behind: u32,
    pub commits_to_push: Vec<PushCommit>,
    pub overwritten_commit_count: u32,
    pub changed_paths: Vec<String>,
    pub changed_path_count: u32,
    pub omitted_changed_path_count: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushCommit {
    pub oid: String,
    pub subject: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PushError {
    NoCurrentBranch,
    NoUpstream,
    InvalidUpstream,
    UpstreamGone,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
}

#[cfg(test)]
pub async fn read_push_preflight(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
) -> Result<PushPreflight, PushError> {
    read_push_preflight_for_target(repo_id, repository_path, current, detached, None).await
}

pub async fn read_push_preflight_for_target(
    repo_id: String,
    repository_path: &Path,
    current: Option<&str>,
    detached: bool,
    target: Option<(&str, &str)>,
) -> Result<PushPreflight, PushError> {
    if detached || current.is_none() {
        return Err(PushError::NoCurrentBranch);
    }
    let local_branch = current.ok_or(PushError::NoCurrentBranch)?;
    crate::features::branches::validate_branch_name(repository_path, local_branch)
        .await
        .map_err(|_| PushError::NoCurrentBranch)?;
    let (local_oid, remote_name, remote_branch) = if let Some((remote_name, remote_branch)) = target
    {
        crate::remotes::validate_remote_name(repository_path, remote_name)
            .await
            .map_err(|_| PushError::InvalidUpstream)?;
        let remotes = crate::remotes::read_remotes(repo_id.clone(), repository_path)
            .await
            .map_err(|_| PushError::InvalidUpstream)?;
        if !remotes
            .remotes
            .iter()
            .any(|remote| remote.name == remote_name)
        {
            return Err(PushError::InvalidUpstream);
        }
        crate::features::branches::validate_branch_name(repository_path, remote_branch)
            .await
            .map_err(|_| PushError::InvalidUpstream)?;
        let local_oid = run_git(
            repository_path,
            &[
                "rev-parse".into(),
                "--verify".into(),
                format!("refs/heads/{local_branch}^{{commit}}").into(),
            ],
        )
        .await?;
        let local_oid = text(
            local_oid
                .split(|byte| *byte == b'\n')
                .next()
                .unwrap_or_default(),
        )?
        .to_owned();
        (local_oid, remote_name.to_owned(), remote_branch.to_owned())
    } else {
        let upstream_config = run_git(
            repository_path,
            &[
                "for-each-ref".into(),
                "--format=%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)".into(),
                format!("refs/heads/{local_branch}").into(),
            ],
        )
        .await?;
        let fields = upstream_config.split(|byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() < 3 {
            return Err(PushError::GitFailed);
        }
        let local_oid = text(fields[0])?.to_owned();
        let remote_name = text(fields[1])?.to_owned();
        let remote_ref = text(fields[2])?.to_owned();
        if remote_name.is_empty() || remote_ref.is_empty() {
            return Err(PushError::NoUpstream);
        }
        if remote_name == "." || !remote_ref.starts_with("refs/heads/") {
            return Err(PushError::InvalidUpstream);
        }
        let remote_branch = remote_ref
            .strip_prefix("refs/heads/")
            .filter(|name| !name.is_empty())
            .ok_or(PushError::InvalidUpstream)?;
        (local_oid, remote_name, remote_branch.to_owned())
    };
    crate::remotes::validate_remote_name(repository_path, &remote_name)
        .await
        .map_err(|_| PushError::InvalidUpstream)?;
    crate::features::branches::validate_branch_name(repository_path, &remote_branch)
        .await
        .map_err(|_| PushError::InvalidUpstream)?;
    let tracking_ref = format!("refs/remotes/{remote_name}/{remote_branch}");
    let remote_oid = run_git(
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            format!("{tracking_ref}^{{commit}}").into(),
        ],
    )
    .await
    .map_err(|error| match error {
        PushError::GitFailed => PushError::UpstreamGone,
        other => other,
    })?;
    let expected_remote_oid = text(
        remote_oid
            .split(|byte| *byte == b'\n')
            .next()
            .unwrap_or_default(),
    )?
    .to_owned();
    let counts = run_git(
        repository_path,
        &[
            "rev-list".into(),
            "--left-right".into(),
            "--count".into(),
            format!("{tracking_ref}...refs/heads/{local_branch}").into(),
        ],
    )
    .await?;
    let counts = std::str::from_utf8(&counts).map_err(|_| PushError::GitFailed)?;
    let mut counts = counts.split_whitespace();
    let behind = counts
        .next()
        .ok_or(PushError::GitFailed)?
        .parse::<u32>()
        .map_err(|_| PushError::GitFailed)?;
    let ahead = counts
        .next()
        .ok_or(PushError::GitFailed)?
        .parse::<u32>()
        .map_err(|_| PushError::GitFailed)?;
    let commit_output = run_git(
        repository_path,
        &[
            "log".into(),
            "--format=%H%x00%s".into(),
            format!("-n{MAX_PREVIEW_COMMITS}").into(),
            format!("{tracking_ref}..refs/heads/{local_branch}").into(),
        ],
    )
    .await?;
    let commits_to_push = std::str::from_utf8(&commit_output)
        .map_err(|_| PushError::GitFailed)?
        .lines()
        .map(|line| {
            let (oid, subject) = line.split_once('\0').ok_or(PushError::GitFailed)?;
            Ok(PushCommit {
                oid: oid.to_owned(),
                subject: subject.to_owned(),
            })
        })
        .collect::<Result<Vec<_>, PushError>>()?;
    let path_output = run_git(
        repository_path,
        &[
            "diff".into(),
            "--name-only".into(),
            "-z".into(),
            "--no-renames".into(),
            tracking_ref.into(),
            format!("refs/heads/{local_branch}").into(),
        ],
    )
    .await?;
    let paths = path_output
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    let changed_path_count = u32::try_from(paths.len()).map_err(|_| PushError::TooLarge)?;
    let changed_paths = paths
        .iter()
        .take(MAX_PREVIEW_PATHS)
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect::<Vec<_>>();
    Ok(PushPreflight {
        repo_id,
        local_branch: local_branch.to_owned(),
        remote_name: remote_name.to_owned(),
        remote_branch,
        local_oid,
        expected_remote_oid,
        ahead,
        behind,
        commits_to_push,
        overwritten_commit_count: behind,
        changed_path_count,
        omitted_changed_path_count: changed_path_count.saturating_sub(changed_paths.len() as u32),
        changed_paths,
    })
}

fn text(bytes: &[u8]) -> Result<&str, PushError> {
    std::str::from_utf8(bytes)
        .map(str::trim)
        .map_err(|_| PushError::GitFailed)
}

async fn run_git(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
) -> Result<Vec<u8>, PushError> {
    let mut command = Command::new("git");
    command
        .current_dir(repository_path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| PushError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(PushError::GitFailed)?;
    let stderr = child.stderr.take().ok_or(PushError::GitFailed)?;
    let stdout_reader = tokio::spawn(read_limited(stdout, MAX_PUSH_PREVIEW_OUTPUT));
    let stderr_reader = tokio::spawn(read_limited(stderr, 16 * 1024));
    let status = match tokio::time::timeout(PUSH_PREVIEW_DEADLINE, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            let _ = child.kill().await;
            return Err(PushError::GitFailed);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(PushError::TimedOut);
        }
    };
    let stdout = stdout_reader
        .await
        .map_err(|_| PushError::GitFailed)?
        .map_err(|_| PushError::GitFailed)?;
    let _stderr = stderr_reader
        .await
        .map_err(|_| PushError::GitFailed)?
        .map_err(|_| PushError::GitFailed)?;
    if stdout.len() > MAX_PUSH_PREVIEW_OUTPUT {
        return Err(PushError::TooLarge);
    }
    if !status.success() {
        return Err(PushError::GitFailed);
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

    fn commit(path: &Path, file: &str, content: &str, subject: &str) {
        std::fs::write(path.join(file), content).unwrap();
        git(path, &["add", file]);
        git(path, &["commit", "--quiet", "-m", subject]);
    }

    #[tokio::test]
    async fn preflight_reports_push_and_overwrite_scope_for_diverged_upstream() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join("local");
        let other = directory.path().join("other");
        let bare = directory.path().join("origin.git");
        std::fs::create_dir(&local).unwrap();
        git(&local, &["init", "--quiet"]);
        git(&local, &["config", "user.name", "Push Test"]);
        git(&local, &["config", "user.email", "push@example.invalid"]);
        commit(&local, "base.txt", "base\n", "base");
        git(
            directory.path(),
            &["init", "--bare", "--quiet", bare.to_str().unwrap()],
        );
        git(&local, &["remote", "add", "origin", bare.to_str().unwrap()]);
        let branch = git(&local, &["branch", "--show-current"]);
        git(&local, &["push", "--quiet", "-u", "origin", &branch]);
        commit(&local, "local.txt", "local\n", "local change");
        git(
            directory.path(),
            &[
                "clone",
                "--quiet",
                bare.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        git(&other, &["config", "user.name", "Other Test"]);
        git(&other, &["config", "user.email", "other@example.invalid"]);
        commit(&other, "remote.txt", "remote\n", "remote change");
        git(&other, &["push", "--quiet", "origin", &branch]);
        git(&local, &["fetch", "--quiet", "origin"]);

        let preview = read_push_preflight("repo_fixture".into(), &local, Some(&branch), false)
            .await
            .unwrap();
        assert_eq!(preview.remote_name, "origin");
        assert_eq!(preview.remote_branch, branch);
        assert_eq!(preview.ahead, 1);
        assert_eq!(preview.behind, 1);
        assert_eq!(preview.overwritten_commit_count, 1);
        assert_eq!(preview.commits_to_push[0].subject, "local change");
        assert_eq!(preview.changed_path_count, 2);
        assert!(preview.changed_paths.contains(&"local.txt".into()));
        assert!(preview.changed_paths.contains(&"remote.txt".into()));
    }
}
