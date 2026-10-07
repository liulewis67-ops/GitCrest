use std::{path::Path, time::Duration};

use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const MAX_HISTORY_OUTPUT: usize = 8 * 1024 * 1024;
const GIT_READ_DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPage {
    pub repo_id: String,
    pub offset: usize,
    pub limit: usize,
    pub commits: Vec<CommitSummary>,
    pub next_offset: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub committed_at_ms: i64,
    pub subject: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub repo_id: String,
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub committed_at_ms: i64,
    pub message: String,
    pub stats: CommitStats,
    pub files: Vec<CommitFileStat>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStats {
    pub files_changed: usize,
    pub insertions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileStat {
    pub path: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefSnapshot {
    pub repo_id: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub refs: Vec<RepositoryRef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRef {
    pub name: String,
    pub full_name: String,
    pub oid: String,
    pub kind: String,
    pub upstream: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HistoryError {
    InvalidQuery,
    InvalidCommit,
    CommitNotFound,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
}

pub async fn read_page(
    repo_id: String,
    repository_path: &Path,
    offset: usize,
    limit: usize,
    head: Option<&str>,
) -> Result<CommitPage, HistoryError> {
    if limit == 0 || limit > 100 || offset > 1_000_000 {
        return Err(HistoryError::InvalidQuery);
    }
    let mut arguments = vec![
        "log".into(),
        "--topo-order".into(),
        "--format=tformat:%H%x00%P%x00%an%x00%ae%x00%at%x00%s".into(),
        format!("--skip={offset}").into(),
        format!("--max-count={}", limit + 1).into(),
    ];
    if head.is_some() {
        arguments.push("HEAD".into());
    }
    arguments.push("--branches".into());
    arguments.push("--remotes".into());
    let output = run_git(repository_path, &arguments, MAX_HISTORY_OUTPUT).await?;
    let mut commits = Vec::new();
    for record in output
        .split(|byte| *byte == b'\n')
        .filter(|record| !record.is_empty())
    {
        let fields = record.splitn(6, |byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() != 6 {
            return Err(HistoryError::GitFailed);
        }
        let oid = text(fields[0]);
        let parents = split_words(fields[1]);
        let author_name = text(fields[2]);
        let author_email = text(fields[3]);
        let committed_at_ms = parse_timestamp(fields[4])?;
        let subject = text(fields[5]);
        commits.push(CommitSummary {
            oid,
            parents,
            author_name,
            author_email,
            committed_at_ms,
            subject,
        });
    }
    let has_more = commits.len() > limit;
    if has_more {
        commits.pop();
    }
    Ok(CommitPage {
        repo_id,
        offset,
        limit,
        commits,
        next_offset: has_more.then_some(offset + limit),
    })
}

pub async fn read_refs(
    repo_id: String,
    repository_path: &Path,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
) -> Result<RefSnapshot, HistoryError> {
    let output = run_git(
        repository_path,
        &[
            "for-each-ref".into(),
            "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)".into(),
            "refs/heads".into(),
            "refs/remotes".into(),
        ],
        MAX_HISTORY_OUTPUT,
    )
    .await?;
    let mut refs = Vec::new();
    for record in output
        .split(|byte| *byte == b'\n')
        .filter(|record| !record.is_empty())
    {
        let fields = record.splitn(4, |byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() != 4 {
            return Err(HistoryError::GitFailed);
        }
        let full_name = text(fields[0]);
        let name = text(fields[1]);
        let oid = text(fields[2]);
        let upstream = nonempty(text(fields[3]));
        let kind = if full_name.starts_with("refs/heads/") {
            "local"
        } else {
            "remote"
        };
        refs.push(RepositoryRef {
            name,
            full_name,
            oid,
            kind: kind.into(),
            upstream,
        });
    }
    Ok(RefSnapshot {
        repo_id,
        head,
        branch,
        detached,
        refs,
    })
}

pub async fn read_commit(
    repo_id: String,
    repository_path: &Path,
    oid: &str,
) -> Result<CommitDetail, HistoryError> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HistoryError::InvalidCommit);
    }
    match run_git(
        repository_path,
        &["cat-file".into(), "-t".into(), oid.into()],
        1024,
    )
    .await
    {
        Ok(kind) if kind == b"commit\n" || kind == b"commit" => {}
        Ok(_) => return Err(HistoryError::CommitNotFound),
        Err(HistoryError::GitFailed) => return Err(HistoryError::CommitNotFound),
        Err(error) => return Err(error),
    }
    let metadata = run_git(
        repository_path,
        &[
            "show".into(),
            "-s".into(),
            "--format=format:%H%x00%P%x00%an%x00%ae%x00%at%x00%B".into(),
            oid.into(),
        ],
        MAX_HISTORY_OUTPUT,
    )
    .await?;
    let fields = metadata.splitn(6, |byte| *byte == 0).collect::<Vec<_>>();
    if fields.len() != 6 {
        return Err(HistoryError::GitFailed);
    }
    let parents = split_words(fields[1]);
    let message = text(fields[5]).trim_end_matches(['\r', '\n']).to_owned();
    let stat_arguments = if let Some(parent) = parents.first() {
        vec![
            "diff".into(),
            "--no-ext-diff".into(),
            "--numstat".into(),
            "-z".into(),
            "--no-renames".into(),
            parent.into(),
            oid.into(),
        ]
    } else {
        vec![
            "diff-tree".into(),
            "--root".into(),
            "--no-commit-id".into(),
            "--numstat".into(),
            "-r".into(),
            "-z".into(),
            "--no-renames".into(),
            oid.into(),
        ]
    };
    let stat_output = run_git(repository_path, &stat_arguments, MAX_HISTORY_OUTPUT).await?;
    let files = parse_numstat(&stat_output)?;
    let insertions = files.iter().filter_map(|file| file.additions).sum();
    let deletions = files.iter().filter_map(|file| file.deletions).sum();
    Ok(CommitDetail {
        repo_id,
        oid: text(fields[0]),
        parents,
        author_name: text(fields[2]),
        author_email: text(fields[3]),
        committed_at_ms: parse_timestamp(fields[4])?,
        message,
        stats: CommitStats {
            files_changed: files.len(),
            insertions,
            deletions,
        },
        files,
    })
}

fn parse_numstat(output: &[u8]) -> Result<Vec<CommitFileStat>, HistoryError> {
    let mut files = Vec::new();
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let first = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or(HistoryError::GitFailed)?;
        let second = record[first + 1..]
            .iter()
            .position(|byte| *byte == b'\t')
            .map(|index| first + 1 + index)
            .ok_or(HistoryError::GitFailed)?;
        let additions = parse_count(&record[..first]);
        let deletions = parse_count(&record[first + 1..second]);
        files.push(CommitFileStat {
            path: text(&record[second + 1..]),
            additions,
            deletions,
        });
    }
    Ok(files)
}

fn parse_count(value: &[u8]) -> Option<u64> {
    if value == b"-" {
        None
    } else {
        std::str::from_utf8(value).ok()?.parse().ok()
    }
}

fn parse_timestamp(value: &[u8]) -> Result<i64, HistoryError> {
    std::str::from_utf8(value)
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .and_then(|seconds| seconds.checked_mul(1000))
        .ok_or(HistoryError::GitFailed)
}

fn split_words(value: &[u8]) -> Vec<String> {
    text(value).split_whitespace().map(str::to_owned).collect()
}

fn text(value: &[u8]) -> String {
    String::from_utf8_lossy(value).into_owned()
}

fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

async fn run_git(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
    maximum_output: usize,
) -> Result<Vec<u8>, HistoryError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args(arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| HistoryError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(HistoryError::GitFailed)?;
    let stderr = child.stderr.take().ok_or(HistoryError::GitFailed)?;
    let stdout_reader = tokio::spawn(read_limited(stdout, maximum_output));
    let stderr_reader = tokio::spawn(read_limited(stderr, 16 * 1024));
    let status = match tokio::time::timeout(GIT_READ_DEADLINE, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            let _ = child.kill().await;
            return Err(HistoryError::GitFailed);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(HistoryError::TimedOut);
        }
    };
    let stdout = stdout_reader
        .await
        .map_err(|_| HistoryError::GitFailed)?
        .map_err(|_| HistoryError::GitFailed)?;
    let stderr = stderr_reader
        .await
        .map_err(|_| HistoryError::GitFailed)?
        .map_err(|_| HistoryError::GitFailed)?;
    if stdout.len() > maximum_output {
        return Err(HistoryError::TooLarge);
    }
    if !status.success() {
        let error = String::from_utf8_lossy(&stderr).to_ascii_lowercase();
        if error.contains("not a git repository") || error.contains("bad object") {
            return Err(HistoryError::GitFailed);
        }
        return Err(HistoryError::GitFailed);
    }
    Ok(stdout)
}

async fn read_limited<R>(stream: R, maximum: usize) -> std::io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::with_capacity(maximum.min(64 * 1024));
    stream
        .take((maximum + 1) as u64)
        .read_to_end(&mut output)
        .await?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use std::{path::Path, process::Command as StdCommand};

    use super::*;

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

    fn commit(path: &Path, message: &str) {
        git(path, &["add", "."]);
        git(path, &["commit", "--quiet", "-m", message]);
    }

    #[tokio::test]
    async fn reads_bounded_history_refs_and_first_parent_commit_stats() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "--quiet"]);
        git(path, &["config", "user.name", "GitCrest History"]);
        git(path, &["config", "user.email", "history@example.invalid"]);
        std::fs::write(path.join("root.txt"), "root\n").unwrap();
        commit(path, "root commit");
        let main_branch = git(path, &["branch", "--show-current"]);

        git(path, &["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(path.join("feature.txt"), "feature\n").unwrap();
        commit(path, "feature commit");
        git(path, &["checkout", "--quiet", &main_branch]);
        std::fs::write(path.join("main.txt"), "main\n").unwrap();
        commit(path, "main commit");
        git(
            path,
            &[
                "merge",
                "--quiet",
                "--no-ff",
                "feature",
                "-m",
                "merge feature",
            ],
        );
        git(path, &["tag", "history-tag"]);

        let head = git(path, &["rev-parse", "HEAD"]);
        let first_page = read_page("repo_history".into(), path, 0, 2, Some(&head))
            .await
            .unwrap();
        assert_eq!(first_page.commits.len(), 2);
        assert_eq!(first_page.next_offset, Some(2));
        assert_eq!(first_page.commits[0].oid, head);
        assert_eq!(first_page.commits[0].parents.len(), 2);
        let second_page = read_page("repo_history".into(), path, 2, 2, Some(&head))
            .await
            .unwrap();
        assert!(second_page
            .commits
            .iter()
            .all(|commit| commit.subject != "merge feature"));
        assert_eq!(second_page.next_offset, None);

        let detail = read_commit("repo_history".into(), path, &head)
            .await
            .unwrap();
        assert_eq!(detail.message, "merge feature");
        assert_eq!(detail.parents.len(), 2);
        assert_eq!(detail.stats.files_changed, 1);
        assert_eq!(detail.stats.insertions, 1);
        assert_eq!(detail.files[0].path, "feature.txt");

        let refs = read_refs(
            "repo_history".into(),
            path,
            Some(head),
            Some(main_branch),
            false,
        )
        .await
        .unwrap();
        assert!(refs
            .refs
            .iter()
            .any(|reference| reference.full_name == "refs/heads/feature"));
        assert!(refs
            .refs
            .iter()
            .all(|reference| !reference.full_name.starts_with("refs/tags/")));
        assert!(matches!(
            read_page("repo_history".into(), path, 0, 101, refs.head.as_deref()).await,
            Err(HistoryError::InvalidQuery)
        ));
    }
}
