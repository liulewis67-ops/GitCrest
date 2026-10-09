mod blame;
mod refs;
mod search_index;

use std::{path::Path, time::Duration};

use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const MAX_HISTORY_OUTPUT: usize = 8 * 1024 * 1024;
const MAX_HISTORY_INDEX_OUTPUT: usize = 64 * 1024 * 1024;
const GIT_READ_DEADLINE: Duration = Duration::from_secs(20);
const HISTORY_INDEX_DEADLINE: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPage {
    pub repo_id: String,
    pub offset: usize,
    pub limit: usize,
    pub commits: Vec<CommitSummary>,
    pub next_offset: Option<usize>,
}

#[derive(Clone, Debug, Default)]
pub struct HistoryFilters {
    pub sha: Option<String>,
    pub author: Option<String>,
    pub message: Option<String>,
    pub branch: Option<String>,
    pub path: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
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

pub(crate) use self::blame::read_blame;
pub(crate) use self::refs::read_refs;
#[cfg(test)]
use self::search_index::build_history_search_index;
pub(crate) use self::search_index::read_page_indexed;

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
pub struct BlameDocument {
    pub repo_id: String,
    pub path: String,
    pub revision: Option<String>,
    pub lines: Vec<BlameLine>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line_number: u32,
    pub original_line_number: u32,
    pub commit_oid: String,
    pub author_name: String,
    pub author_email: String,
    pub committed_at_ms: i64,
    pub summary: String,
    pub text: String,
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
    filters: &HistoryFilters,
) -> Result<CommitPage, HistoryError> {
    if limit == 0 || limit > 100 || offset > 1_000_000 || !valid_filters(filters) {
        return Err(HistoryError::InvalidQuery);
    }
    let mut arguments = vec!["log".into()];
    arguments.push("--format=tformat:%H%x00%P%x00%an%x00%ae%x00%at%x00%s".into());
    if let Some(sha) = &filters.sha {
        if offset > 0 {
            return Ok(CommitPage {
                repo_id,
                offset,
                limit,
                commits: Vec::new(),
                next_offset: None,
            });
        }
        let resolved = run_git(
            repository_path,
            &[
                "rev-parse".into(),
                "--verify".into(),
                format!("{sha}^{{commit}}").into(),
            ],
            1024,
        )
        .await
        .map_err(|error| {
            if error == HistoryError::GitFailed {
                HistoryError::InvalidQuery
            } else {
                error
            }
        })?;
        let resolved = text(&resolved).trim().to_owned();
        let refs = read_refs(String::new(), repository_path, None, None, false).await?;
        let allowed_refs = if let Some(branch) = &filters.branch {
            vec![refs
                .refs
                .iter()
                .find(|reference| reference.name == *branch)
                .ok_or(HistoryError::InvalidQuery)?
                .full_name
                .clone()]
        } else {
            refs.refs
                .iter()
                .map(|reference| reference.full_name.clone())
                .collect()
        };
        let reachability_arguments = vec![
            "branch".into(),
            "--all".into(),
            format!("--contains={resolved}").into(),
            "--format=%(refname)".into(),
        ];
        let reachable_output =
            run_git(repository_path, &reachability_arguments, MAX_HISTORY_OUTPUT).await?;
        let reachable = String::from_utf8_lossy(&reachable_output);
        if head != Some(resolved.as_str())
            && !allowed_refs
                .iter()
                .any(|reference| reachable.lines().any(|line| line == reference))
        {
            return Ok(CommitPage {
                repo_id,
                offset,
                limit,
                commits: Vec::new(),
                next_offset: None,
            });
        }
        arguments.push("--no-walk=unsorted".into());
        arguments.push(resolved.into());
    } else if let Some(branch) = &filters.branch {
        let refs = read_refs(String::new(), repository_path, None, None, false).await?;
        let selected = refs
            .refs
            .iter()
            .find(|reference| reference.name == *branch)
            .ok_or(HistoryError::InvalidQuery)?;
        arguments.push(selected.full_name.clone().into());
    } else {
        if head.is_some() {
            arguments.push("HEAD".into());
        }
        arguments.push("--branches".into());
        arguments.push("--remotes".into());
    }
    if let Some(author) = &filters.author {
        arguments.push(format!("--author={}", regex_escape(author)).into());
    }
    if let Some(message) = &filters.message {
        arguments.push(format!("--grep={message}").into());
        arguments.push("--fixed-strings".into());
        arguments.push("--regexp-ignore-case".into());
    }
    if let Some(since) = &filters.since {
        arguments.push(format!("--since={since}T00:00:00Z").into());
    }
    if let Some(until) = &filters.until {
        arguments.push(format!("--until={until}T23:59:59Z").into());
    }
    if filters.sha.is_none() {
        arguments.push(format!("--skip={offset}").into());
        arguments.push(format!("--max-count={}", limit + 1).into());
    }
    if let Some(path) = &filters.path {
        arguments.push("--".into());
        arguments.push(format!(":(literal){path}").into());
    }
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

fn valid_filters(filters: &HistoryFilters) -> bool {
    let bounded_text = |value: &Option<String>, maximum: usize| {
        value.as_ref().is_none_or(|value| {
            !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
        })
    };
    if !bounded_text(&filters.author, 256)
        || !bounded_text(&filters.message, 512)
        || !bounded_text(&filters.branch, 256)
        || !bounded_text(&filters.path, 4096)
    {
        return false;
    }
    if let Some(sha) = &filters.sha {
        if !(4..=64).contains(&sha.len()) || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return false;
        }
    }
    if let Some(path) = &filters.path {
        if path.starts_with('/')
            || path.contains('\\')
            || path.split('/').any(|part| part == ".." || part == ".")
            || (path.as_bytes().get(1) == Some(&b':'))
        {
            return false;
        }
    }
    if filters.since.as_ref().is_some_and(|date| !valid_date(date))
        || filters.until.as_ref().is_some_and(|date| !valid_date(date))
    {
        return false;
    }
    if let (Some(since), Some(until)) = (&filters.since, &filters.until) {
        if since > until {
            return false;
        }
    }
    true
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return false;
    }
    let year = value[..4].parse::<u32>().ok();
    let month = value[5..7].parse::<u32>().ok();
    let day = value[8..10].parse::<u32>().ok();
    match (year, month, day) {
        (Some(year), Some(month @ 1..=12), Some(day)) => {
            let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
            let days = match month {
                2 if leap => 29,
                2 => 28,
                4 | 6 | 9 | 11 => 30,
                _ => 31,
            };
            (1..=days).contains(&day)
        }
        _ => false,
    }
}

fn regex_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if "\\.^$|?*+()[]{}".contains(character) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
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
    run_git_with_deadline(
        repository_path,
        arguments,
        maximum_output,
        GIT_READ_DEADLINE,
    )
    .await
}

async fn run_git_with_deadline(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
    maximum_output: usize,
    deadline: Duration,
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
    let status = match tokio::time::timeout(deadline, child.wait()).await {
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

    use crate::features::repositories::repository::RepositoryManager;

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

    #[test]
    fn validates_history_filter_dates_paths_and_sha_prefixes() {
        assert!(valid_date("2024-02-29"));
        assert!(!valid_date("2026-02-29"));
        assert!(!valid_date("2026-13-01"));
        assert!(valid_filters(&HistoryFilters {
            sha: Some("a1b2".into()),
            since: Some("2024-01-01".into()),
            until: Some("2024-12-31".into()),
            ..HistoryFilters::default()
        }));
        assert!(!valid_filters(&HistoryFilters {
            path: Some("../outside".into()),
            ..HistoryFilters::default()
        }));
        assert!(!valid_filters(&HistoryFilters {
            sha: Some("xyz".into()),
            ..HistoryFilters::default()
        }));
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
        let no_filters = HistoryFilters::default();
        let first_page = read_page("repo_history".into(), path, 0, 2, Some(&head), &no_filters)
            .await
            .unwrap();
        assert_eq!(first_page.commits.len(), 2);
        assert_eq!(first_page.next_offset, Some(2));
        assert_eq!(first_page.commits[0].oid, head);
        assert_eq!(first_page.commits[0].parents.len(), 2);
        let second_page = read_page("repo_history".into(), path, 2, 2, Some(&head), &no_filters)
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
            read_page(
                "repo_history".into(),
                path,
                0,
                101,
                refs.head.as_deref(),
                &no_filters
            )
            .await,
            Err(HistoryError::InvalidQuery)
        ));
    }

    #[tokio::test]
    async fn indexed_message_search_matches_git_order_and_invalidates_after_ref_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "--quiet"]);
        git(path, &["config", "user.name", "GitCrest History"]);
        git(path, &["config", "user.email", "history@example.invalid"]);
        std::fs::write(path.join("history.txt"), "one\n").unwrap();
        commit(path, "root entry");
        std::fs::write(path.join("history.txt"), "two\n").unwrap();
        commit(path, "Feature needle in C++");
        std::fs::write(path.join("history.txt"), "three\n").unwrap();
        commit(path, "second NEEDLE entry");

        let manager = RepositoryManager::default();
        let repository = manager.open_path(path.to_str().unwrap()).await.unwrap();
        let store = manager.store();
        build_history_search_index(
            &repository.repo_id,
            path,
            repository.head.as_deref(),
            None,
            &store,
        )
        .await
        .unwrap();

        let filters = HistoryFilters {
            message: Some("nEeDlE".into()),
            ..HistoryFilters::default()
        };
        let indexed = read_page_indexed(
            repository.repo_id.clone(),
            path,
            0,
            1,
            repository.head.as_deref(),
            &filters,
            store.clone(),
        )
        .await
        .unwrap();
        let expected = read_page(
            repository.repo_id.clone(),
            path,
            0,
            1,
            repository.head.as_deref(),
            &filters,
        )
        .await
        .unwrap();
        assert_eq!(indexed.commits[0].oid, expected.commits[0].oid);
        assert_eq!(indexed.commits[0].subject, "second NEEDLE entry");
        assert_eq!(indexed.next_offset, Some(1));

        let short_query = HistoryFilters {
            message: Some("++".into()),
            ..HistoryFilters::default()
        };
        let short_result = read_page_indexed(
            repository.repo_id.clone(),
            path,
            0,
            10,
            repository.head.as_deref(),
            &short_query,
            store.clone(),
        )
        .await
        .unwrap();
        assert_eq!(short_result.commits[0].subject, "Feature needle in C++");

        std::fs::write(path.join("history.txt"), "four\n").unwrap();
        commit(path, "needle after index");
        let after_ref_change = read_page_indexed(
            repository.repo_id.clone(),
            path,
            0,
            10,
            repository.head.as_deref(),
            &filters,
            store,
        )
        .await
        .unwrap();
        assert_eq!(after_ref_change.commits[0].subject, "needle after index");
    }

    #[tokio::test]
    async fn reads_line_blame_matching_git_for_head_and_a_historical_revision() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "--quiet"]);
        git(path, &["config", "user.name", "GitCrest Blame"]);
        git(path, &["config", "user.email", "blame@example.invalid"]);
        std::fs::write(path.join("source.txt"), "root line\nshared line\n").unwrap();
        commit(path, "root source");
        let root_oid = git(path, &["rev-parse", "HEAD"]);
        std::fs::write(
            path.join("source.txt"),
            "root line\nshared line\nnew line\n",
        )
        .unwrap();
        commit(path, "add third line");
        let head_oid = git(path, &["rev-parse", "HEAD"]);

        let head = read_blame("repo_history".into(), path, "source.txt", None)
            .await
            .unwrap();
        assert_eq!(head.lines.len(), 3);
        assert_eq!(head.lines[0].line_number, 1);
        assert_eq!(head.lines[0].original_line_number, 1);
        assert_eq!(head.lines[0].commit_oid, root_oid);
        assert_eq!(head.lines[0].text, "root line");
        assert_eq!(head.lines[2].line_number, 3);
        assert_eq!(head.lines[2].commit_oid, head_oid);
        assert_eq!(head.lines[2].summary, "add third line");

        let historical = read_blame("repo_history".into(), path, "source.txt", Some(&root_oid))
            .await
            .unwrap();
        assert_eq!(historical.revision.as_deref(), Some(root_oid.as_str()));
        assert_eq!(historical.lines.len(), 2);
        assert!(historical
            .lines
            .iter()
            .all(|line| line.commit_oid == root_oid));
        assert!(matches!(
            read_blame("repo_history".into(), path, "../outside", None).await,
            Err(HistoryError::InvalidQuery)
        ));
        assert!(matches!(
            read_blame("repo_history".into(), path, "source.txt", Some("--all")).await,
            Err(HistoryError::InvalidQuery)
        ));
        assert!(matches!(
            read_blame(
                "repo_history".into(),
                path,
                "source.txt",
                Some("f".repeat(40).as_str())
            )
            .await,
            Err(HistoryError::CommitNotFound)
        ));
    }
}
