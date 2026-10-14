mod blame;
mod commit_detail;
mod commit_history;
mod refs;
mod search_index;

use std::{path::Path, time::Duration};

use super::model::*;

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const MAX_HISTORY_OUTPUT: usize = 8 * 1024 * 1024;
const MAX_HISTORY_INDEX_OUTPUT: usize = 64 * 1024 * 1024;
const GIT_READ_DEADLINE: Duration = Duration::from_secs(20);
const HISTORY_INDEX_DEADLINE: Duration = Duration::from_secs(60);

pub(crate) use self::blame::read_blame;
pub(crate) use self::commit_detail::read_commit;
#[cfg(test)]
use self::commit_history::{read_page, valid_date, valid_filters};
pub(crate) use self::refs::read_refs;
pub(crate) use self::search_index::read_page_indexed;
#[cfg(test)]
use self::search_index::refs_fingerprint;
#[cfg(test)]
use self::search_index::build_history_search_index;

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

/// Runs git on a blocking thread and drains stdout with large reads. Tokio's pipe
/// reader uses small chunks, which dominates multi-megabyte exports such as the
/// history message index.
async fn run_git_bulk_with_deadline(
    repository_path: &Path,
    arguments: &[std::ffi::OsString],
    maximum_output: usize,
    deadline: Duration,
) -> Result<Vec<u8>, HistoryError> {
    let repository_path = repository_path.to_owned();
    let arguments = arguments.to_vec();
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut child = std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_path)
            .args(&arguments)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| HistoryError::GitUnavailable)?;
        let mut stdout = child.stdout.take().ok_or(HistoryError::GitFailed)?;
        let reader = std::thread::spawn(move || {
            let mut output = Vec::with_capacity(maximum_output.min(8 * 1024 * 1024));
            let mut buffer = vec![0_u8; 1024 * 1024];
            loop {
                let read = stdout.read(&mut buffer)?;
                if read == 0 {
                    return Ok::<_, std::io::Error>(output);
                }
                if output.len() + read > maximum_output {
                    output.extend_from_slice(&buffer[..maximum_output.saturating_sub(output.len())]);
                    output.push(0);
                    return Ok(output);
                }
                output.extend_from_slice(&buffer[..read]);
            }
        });
        let started = std::time::Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err(HistoryError::TimedOut);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(2)),
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err(HistoryError::GitFailed);
                }
            }
        };
        let output = reader
            .join()
            .map_err(|_| HistoryError::GitFailed)?
            .map_err(|_| HistoryError::GitFailed)?;
        if output.len() > maximum_output {
            return Err(HistoryError::TooLarge);
        }
        if !status.success() {
            return Err(HistoryError::GitFailed);
        }
        Ok(output)
    })
    .await
    .map_err(|_| HistoryError::GitFailed)?
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
    use std::{path::Path, process::Command as StdCommand, sync::Arc};

    use crate::features::repositories::repository::RepositoryManager;
    use crate::ports::history::HistorySearchIndexPort;
    use sha2::{Digest, Sha256};

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

    fn git_reference_fingerprint(refs: &[u8], head: Option<&str>) -> String {
        let mut digest = Sha256::new();
        let attached_head_is_in_refs = refs.windows(3).any(|value| value == b"\0*\n");
        if !attached_head_is_in_refs {
            digest.update(head.unwrap_or_default().as_bytes());
            digest.update([0]);
        }
        digest.update(refs);
        format!("{:x}", digest.finalize())
    }

    #[tokio::test]
    async fn refs_fingerprint_preserves_git_ref_bytes_for_attached_and_detached_heads() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "--quiet"]);
        git(path, &["config", "user.name", "GitCrest History"]);
        git(path, &["config", "user.email", "history@example.invalid"]);
        std::fs::write(path.join("history.txt"), "root\n").unwrap();
        commit(path, "root entry");
        let head = git(path, &["rev-parse", "HEAD"]);
        git(path, &["branch", "feature"]);
        git(path, &["update-ref", "refs/remotes/origin/main", &head]);

        let read_git_refs = || async {
            run_git(
                path,
                &[
                    "for-each-ref".into(),
                    "--format=%(refname)%00%(objectname)%00%(HEAD)".into(),
                    "refs/heads".into(),
                    "refs/remotes".into(),
                ],
                MAX_HISTORY_OUTPUT,
            )
            .await
            .unwrap()
        };
        let attached_refs = read_git_refs().await;
        assert_eq!(
            refs_fingerprint(path, Some(&head)).await.unwrap(),
            git_reference_fingerprint(&attached_refs, Some(&head)),
        );

        git(path, &["checkout", "--quiet", "--detach", "HEAD"]);
        let detached_refs = read_git_refs().await;
        assert_eq!(
            refs_fingerprint(path, Some(&head)).await.unwrap(),
            git_reference_fingerprint(&detached_refs, Some(&head)),
        );
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

    fn commit_at(path: &Path, message: &str, timestamp: i64) {
        git(path, &["add", "."]);
        let date = format!("{timestamp} +0000");
        let output = StdCommand::new("git")
            .arg("-C")
            .arg(path)
            .args(["commit", "--quiet", "-m", message])
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap();
        assert!(output.status.success());
    }

    async fn build_and_expect_git_order(
        manager: &RepositoryManager,
        path: &Path,
        store: &Arc<dyn HistorySearchIndexPort>,
    ) -> Vec<String> {
        let repository = manager.open_path(path.to_str().unwrap()).await.unwrap();
        build_history_search_index(
            &repository.repo_id,
            path,
            repository.head.as_deref(),
            None,
            store.clone(),
        )
        .await
        .unwrap();
        let fingerprint = refs_fingerprint(path, repository.head.as_deref())
            .await
            .unwrap();
        let indexed: Vec<String> = store
            .search_messages(&repository.repo_id, &fingerprint, "needle", 0, 100)
            .unwrap()
            .expect("index should match the current refs")
            .into_iter()
            .map(|entry| entry.oid)
            .collect();
        let expected: Vec<String> = git(path, &["log", "--format=%H", "HEAD", "--branches", "--remotes"])
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(indexed, expected);
        indexed
    }

    #[tokio::test]
    async fn incremental_index_prepends_newer_commits_and_falls_back_otherwise() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "--quiet", "-b", "main"]);
        git(path, &["config", "user.name", "GitCrest History"]);
        git(path, &["config", "user.email", "history@example.invalid"]);
        let base = 1_700_000_000_i64;
        std::fs::write(path.join("history.txt"), "one\n").unwrap();
        commit_at(path, "needle one", base);
        std::fs::write(path.join("history.txt"), "two\n").unwrap();
        commit_at(path, "needle two", base + 100);

        let manager = RepositoryManager::default();
        let store: Arc<dyn HistorySearchIndexPort> = Arc::new(manager.store());
        let initial = build_and_expect_git_order(&manager, path, &store).await;
        assert_eq!(initial.len(), 2);
        let repo_id = manager
            .open_path(path.to_str().unwrap())
            .await
            .unwrap()
            .repo_id;
        let first_basis = store.index_basis(&repo_id).expect("full build records a basis");
        assert_eq!(first_basis.max_commit_time, base + 100);

        // Newer commits on main and on a side branch: incremental path.
        std::fs::write(path.join("history.txt"), "three\n").unwrap();
        commit_at(path, "needle three", base + 200);
        git(path, &["checkout", "--quiet", "-b", "side"]);
        std::fs::write(path.join("history.txt"), "four\n").unwrap();
        commit_at(path, "needle four", base + 300);
        git(path, &["checkout", "--quiet", "main"]);
        let after_newer = build_and_expect_git_order(&manager, path, &store).await;
        assert_eq!(after_newer.len(), 4);
        let second_basis = store.index_basis(&repo_id).unwrap();
        assert_eq!(second_basis.max_commit_time, base + 300);
        assert_ne!(second_basis.tips, first_basis.tips);

        // A commit older than the newest indexed one cannot be prepended safely.
        git(path, &["checkout", "--quiet", "-b", "backdated", "main"]);
        std::fs::write(path.join("history.txt"), "five\n").unwrap();
        commit_at(path, "needle five", base + 50);
        let after_backdated = build_and_expect_git_order(&manager, path, &store).await;
        assert_eq!(after_backdated.len(), 5);

        // Deleting a branch drops indexed commits: full rebuild.
        git(path, &["checkout", "--quiet", "main"]);
        git(path, &["branch", "-D", "side"]);
        let after_reset = build_and_expect_git_order(&manager, path, &store).await;
        assert!(after_reset.len() < 5);
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
        let store: Arc<dyn HistorySearchIndexPort> = Arc::new(manager.store());
        let initial_page = read_page_indexed(
            repository.repo_id.clone(),
            path,
            0,
            1,
            repository.head.as_deref(),
            &HistoryFilters::default(),
            store.clone(),
        )
        .await
        .unwrap();
        assert_eq!(initial_page.commits[0].subject, "second NEEDLE entry");
        let filters = HistoryFilters {
            message: Some("nEeDlE".into()),
            ..HistoryFilters::default()
        };
        let cold = read_page_indexed(
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
        if cold.search_pending {
            assert!(cold.commits.is_empty());
        } else {
            assert_eq!(cold.commits[0].subject, "second NEEDLE entry");
        }
        let fingerprint = refs_fingerprint(path, repository.head.as_deref())
            .await
            .unwrap();
        let mut index_ready = false;
        for _ in 0..100 {
            let search = store.search_messages(&repository.repo_id, &fingerprint, "needle", 0, 1);
            if search.unwrap().is_some() {
                index_ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            index_ready,
            "the initial history page should schedule index building"
        );

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
        assert!(!indexed.search_pending);
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
        assert_eq!(indexed.commits[0].parents, expected.commits[0].parents);
        assert_eq!(
            indexed.commits[0].author_name,
            expected.commits[0].author_name
        );
        assert_eq!(
            indexed.commits[0].author_email,
            expected.commits[0].author_email
        );
        assert_eq!(
            indexed.commits[0].committed_at_ms,
            expected.commits[0].committed_at_ms
        );
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
            store.clone(),
        )
        .await
        .unwrap();
        if after_ref_change.search_pending {
            assert!(after_ref_change.commits.is_empty());
        } else {
            assert_eq!(after_ref_change.commits[0].subject, "needle after index");
        }
        let updated_fingerprint = refs_fingerprint(path, repository.head.as_deref())
            .await
            .unwrap();
        let mut updated_index_ready = false;
        for _ in 0..100 {
            if store
                .search_messages(&repository.repo_id, &updated_fingerprint, "needle", 0, 10)
                .unwrap()
                .is_some()
            {
                updated_index_ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            updated_index_ready,
            "a refs change should rebuild the index"
        );
        let after_ref_change = read_page_indexed(
            repository.repo_id,
            path,
            0,
            10,
            repository.head.as_deref(),
            &filters,
            store,
        )
        .await
        .unwrap();
        assert!(!after_ref_change.search_pending);
        assert_eq!(after_ref_change.commits[0].subject, "needle after index");
        assert_eq!(
            after_ref_change
                .commits
                .iter()
                .map(|commit| commit.subject.as_str())
                .collect::<Vec<_>>(),
            [
                "needle after index",
                "second NEEDLE entry",
                "Feature needle in C++"
            ]
        );
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
