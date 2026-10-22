use std::{fmt::Write as _, path::Path, sync::Arc};

use git2::Repository;
use sha2::{Digest, Sha256};

use crate::{
    domain::commit::CommitSearchEntry,
    ports::history::{HistoryIndexBasis, HistorySearchIndexPort},
};

use super::commit_history::{read_page, valid_filters};
use super::{
    run_git_bulk_with_deadline, text, CommitPage, CommitSummary, HistoryError, HistoryFilters,
    HISTORY_INDEX_DEADLINE, MAX_HISTORY_INDEX_OUTPUT,
};

pub async fn read_page_indexed(
    repo_id: String,
    repository_path: &Path,
    offset: usize,
    limit: usize,
    head: Option<&str>,
    filters: &HistoryFilters,
    store: Arc<dyn HistorySearchIndexPort>,
) -> Result<CommitPage, HistoryError> {
    if limit == 0 || limit > 100 || offset > 1_000_000 || !valid_filters(filters) {
        return Err(HistoryError::InvalidQuery);
    }
    let indexable_message_search = filters
        .message
        .as_deref()
        .is_some_and(|message| message.is_ascii() && message.chars().count() >= 3)
        && filters.sha.is_none()
        && filters.author.is_none()
        && filters.branch.is_none()
        && filters.path.is_none()
        && filters.since.is_none()
        && filters.until.is_none();
    let unfiltered_first_page = offset == 0
        && filters.sha.is_none()
        && filters.author.is_none()
        && filters.message.is_none()
        && filters.branch.is_none()
        && filters.path.is_none()
        && filters.since.is_none()
        && filters.until.is_none();
    let (fingerprint, cached_page, stale_cached_index, index_miss) = if indexable_message_search {
        let message = filters.message.as_deref().unwrap_or_default();
        cached_message_page(
            repo_id.clone(),
            repository_path,
            head,
            message.to_owned(),
            offset,
            limit,
            store.clone(),
        )
        .await
    } else {
        (None, None, false, false)
    };
    if let Some(page) = cached_page {
        return Ok(page);
    }

    if offset == 0 && indexable_message_search && index_miss {
        let build_already_failed = fingerprint
            .as_deref()
            .is_some_and(|fingerprint| store.index_build_failed(&repo_id, fingerprint));
        let build_is_running = store.is_index_building(&repo_id);
        let build_was_started = !build_already_failed
            && !build_is_running
            && schedule_history_index_build(
                repo_id.clone(),
                repository_path.to_owned(),
                head.map(str::to_owned),
                if stale_cached_index {
                    None
                } else {
                    fingerprint.clone()
                },
                store.clone(),
            );
        // A stale (previously built) index rebuilds in the background while the
        // direct Git search answers immediately; only a first-ever build reports
        // pending, because no complete answer is cheap then.
        if (build_is_running || build_was_started) && !store.has_index(&repo_id) {
            return Ok(CommitPage {
                repo_id,
                offset,
                limit,
                commits: Vec::new(),
                next_offset: None,
                search_pending: true,
            });
        }
    }

    let page = read_page(
        repo_id.clone(),
        repository_path,
        offset,
        limit,
        head,
        filters,
    )
    .await?;

    if offset == 0
        && (indexable_message_search || unfiltered_first_page)
        && !store.is_index_building(&repo_id)
        && !fingerprint
            .as_deref()
            .is_some_and(|fingerprint| store.index_build_failed(&repo_id, fingerprint))
    {
        schedule_history_index_build(
            repo_id,
            repository_path.to_owned(),
            head.map(str::to_owned),
            if stale_cached_index {
                None
            } else {
                fingerprint
            },
            store,
        );
    }
    Ok(page)
}

async fn cached_message_page(
    repo_id: String,
    repository_path: &Path,
    head: Option<&str>,
    message: String,
    offset: usize,
    limit: usize,
    store: Arc<dyn HistorySearchIndexPort>,
) -> (Option<String>, Option<CommitPage>, bool, bool) {
    let repository_path = repository_path.to_owned();
    let head = head.map(str::to_owned);
    match tokio::task::spawn_blocking(move || {
        let repository = match Repository::open(repository_path) {
            Ok(repository) => repository,
            Err(_) => {
                eprintln!(
                    "[gitcrest-core] History message index refs fingerprint failed; falling back to Git search"
                );
                return (None, None, false, false);
            }
        };
        let fingerprint = match refs_fingerprint_for_repository(&repository, head.as_deref()) {
            Ok(fingerprint) => fingerprint,
            Err(_) => {
                eprintln!(
                    "[gitcrest-core] History message index refs fingerprint failed; falling back to Git search"
                );
                return (None, None, false, false);
            }
        };
        let entries = match store.search_messages(
            &repo_id,
            &fingerprint,
            &message,
            offset,
            limit + 1,
        ) {
            Ok(entries) => entries,
            Err(_) => {
                eprintln!(
                    "[gitcrest-core] History message index storage query failed; falling back to Git search"
                );
                return (Some(fingerprint), None, false, false);
            }
        };
        let Some(mut entries) = entries else {
            return (Some(fingerprint), None, false, true);
        };
        let has_more = entries.len() > limit;
        if has_more {
            entries.pop();
        }
        let commits = summaries_for_search_entries(&repository, &entries);
        let current_fingerprint = refs_fingerprint_for_repository(&repository, head.as_deref());
        let refs_are_current =
            matches!(&current_fingerprint, Ok(current) if current == &fingerprint);
        if !refs_are_current {
            match current_fingerprint {
                Ok(_) => eprintln!(
                    "[gitcrest-core] History message index refs changed during query; falling back to Git search"
                ),
                Err(_) => eprintln!(
                    "[gitcrest-core] History message index refs recheck failed; falling back to Git search"
                ),
            }
            return (Some(fingerprint), None, true, true);
        }
        let Ok(commits) = commits else {
            eprintln!(
                "[gitcrest-core] History message index commit hydration failed; falling back to Git search"
            );
            return (Some(fingerprint), None, false, false);
        };
        (
            Some(fingerprint),
            Some(CommitPage {
                repo_id,
                offset,
                limit,
                commits,
                next_offset: has_more.then_some(offset + limit),
                search_pending: false,
            }),
            false,
            false,
        )
    })
    .await
    {
        Ok(result) => result,
        Err(_) => {
            eprintln!(
                "[gitcrest-core] History message index query task failed; falling back to Git search"
            );
            (None, None, false, false)
        }
    }
}

fn summaries_for_search_entries(
    repository: &Repository,
    entries: &[CommitSearchEntry],
) -> Result<Vec<CommitSummary>, HistoryError> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    if entries.iter().any(|entry| {
        !matches!(entry.oid.len(), 40 | 64)
            || !entry.oid.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(HistoryError::GitFailed);
    }
    entries
        .iter()
        .map(|entry| {
            let oid = git2::Oid::from_str(&entry.oid).map_err(|_| HistoryError::GitFailed)?;
            let commit = repository
                .find_commit(oid)
                .map_err(|_| HistoryError::GitFailed)?;
            let author = commit.author();
            let committed_at_ms = author
                .when()
                .seconds()
                .checked_mul(1_000)
                .ok_or(HistoryError::GitFailed)?;
            let author_name = text(author.name_bytes());
            let author_email = text(author.email_bytes());
            Ok(CommitSummary {
                oid: entry.oid.clone(),
                parents: commit
                    .parent_ids()
                    .map(|parent| parent.to_string())
                    .collect(),
                author_name,
                author_email,
                committed_at_ms,
                subject: text(commit.summary_bytes().unwrap_or_default()),
            })
        })
        .collect()
}

fn schedule_history_index_build(
    repo_id: String,
    repository_path: std::path::PathBuf,
    head: Option<String>,
    expected_fingerprint: Option<String>,
    store: Arc<dyn HistorySearchIndexPort>,
) -> bool {
    let claimed = expected_fingerprint
        .as_deref()
        .is_some_and(|fingerprint| store.begin_index_build(&repo_id, fingerprint));
    if expected_fingerprint.is_some() && !claimed {
        return false;
    }
    let was_scheduled = claimed || expected_fingerprint.is_none();
    let mut _build_lease = claimed.then(|| HistoryIndexBuildLease {
        repo_id: repo_id.clone(),
        store: store.clone(),
    });
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let preclaimed = claimed;
        let index_fingerprint = match expected_fingerprint {
            Some(fingerprint) => Some(fingerprint),
            None => refs_fingerprint(&repository_path, head.as_deref())
                .await
                .ok(),
        };
        let Some(index_fingerprint) = index_fingerprint else {
            return;
        };
        if !preclaimed && !store.begin_index_build(&repo_id, &index_fingerprint) {
            return;
        }
        if !preclaimed {
            _build_lease = Some(HistoryIndexBuildLease {
                repo_id: repo_id.clone(),
                store: store.clone(),
            });
        }
        let result = build_history_search_index(
            &repo_id,
            &repository_path,
            head.as_deref(),
            Some(&index_fingerprint),
            store.clone(),
        )
        .await;
        if result.is_err() {
            store.fail_index_build(&repo_id, &index_fingerprint);
        }
        let outcome = match &result {
            Ok(()) => "ready",
            Err(HistoryError::TooLarge) => "skipped-too-large",
            Err(HistoryError::TimedOut) => "timed-out",
            Err(_) => "failed",
        };
        eprintln!(
            "[gitcrest-core] History message index {outcome} in {}ms",
            started.elapsed().as_millis()
        );
    });
    was_scheduled
}

struct HistoryIndexBuildLease {
    repo_id: String,
    store: Arc<dyn HistorySearchIndexPort>,
}

impl Drop for HistoryIndexBuildLease {
    fn drop(&mut self) {
        self.store.finish_index_build(&self.repo_id);
    }
}

pub async fn build_history_search_index(
    repo_id: &str,
    repository_path: &Path,
    head: Option<&str>,
    expected_fingerprint: Option<&str>,
    store: Arc<dyn HistorySearchIndexPort>,
) -> Result<(), HistoryError> {
    let fingerprint = refs_fingerprint(repository_path, head).await?;
    if expected_fingerprint.is_some_and(|expected| expected != fingerprint) {
        return Ok(());
    }
    let tips = history_index_tips(repository_path).await?;
    if let Some(old_basis) = store.index_basis(repo_id) {
        match try_prepend_new_commits(
            repo_id,
            repository_path,
            head,
            &fingerprint,
            &tips,
            &old_basis,
            store.clone(),
        )
        .await
        {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(_) => eprintln!(
                "[gitcrest-core] Incremental history index failed; falling back to full rebuild"
            ),
        }
    }
    let git_started = std::time::Instant::now();
    let output = run_git_bulk_with_deadline(
        repository_path,
        &index_log_arguments(head.is_some(), &[], &[]),
        MAX_HISTORY_INDEX_OUTPUT,
        HISTORY_INDEX_DEADLINE,
    )
    .await?;
    let git_elapsed_ms = git_started.elapsed().as_millis();
    let parse_started = std::time::Instant::now();
    let parsed = tokio::task::spawn_blocking(move || parse_history_search_index(&output))
        .await
        .map_err(|_| HistoryError::GitFailed)??;
    let parse_elapsed_ms = parse_started.elapsed().as_millis();
    let verify_started = std::time::Instant::now();
    let final_fingerprint = refs_fingerprint(repository_path, head).await?;
    if final_fingerprint != fingerprint {
        return Ok(());
    }
    let verify_elapsed_ms = verify_started.elapsed().as_millis();
    let repo_id = repo_id.to_owned();
    let basis = HistoryIndexBasis {
        tips,
        max_commit_time: parsed.max_commit_time.unwrap_or(0),
    };
    let entries = parsed.entries;
    let persist_started = std::time::Instant::now();
    let persist_result = match tokio::task::spawn_blocking(move || {
        store.replace_index(&repo_id, &fingerprint, basis, entries)
    })
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => {
            eprintln!("[gitcrest-core] History index persistence failed: {error:?}");
            Err(HistoryError::GitFailed)
        }
        Err(error) => {
            eprintln!("[gitcrest-core] History index persistence task failed: {error}");
            Err(HistoryError::GitFailed)
        }
    };
    let persist_elapsed_ms = persist_started.elapsed().as_millis();
    eprintln!(
        "[gitcrest-core] History index build phases git={git_elapsed_ms}ms parse={parse_elapsed_ms}ms verify={verify_elapsed_ms}ms persist={persist_elapsed_ms}ms"
    );
    persist_result
}

fn index_log_arguments(
    include_head: bool,
    new_tips: &[String],
    old_tips: &[String],
) -> Vec<std::ffi::OsString> {
    let mut arguments: Vec<std::ffi::OsString> = vec!["log".into(), "-z".into()];
    arguments.push("--format=tformat:%H%x00%ct%x00%B".into());
    if new_tips.is_empty() {
        if include_head {
            arguments.push("HEAD".into());
        }
        arguments.push("--branches".into());
        arguments.push("--remotes".into());
    } else {
        arguments.extend(new_tips.iter().map(std::ffi::OsString::from));
        arguments.push("--not".into());
        arguments.extend(old_tips.iter().map(std::ffi::OsString::from));
        arguments.push("--".into());
    }
    arguments
}

/// Commits reachable from HEAD and all local/remote branches, as the object ids
/// `git log HEAD --branches --remotes` starts its walk from.
async fn history_index_tips(repository_path: &Path) -> Result<Vec<String>, HistoryError> {
    let repository_path = repository_path.to_owned();
    tokio::task::spawn_blocking(move || {
        let repository = Repository::open(repository_path).map_err(|_| HistoryError::GitFailed)?;
        let mut tips = std::collections::BTreeSet::new();
        if let Ok(head) = repository.head() {
            if let Ok(commit) = head.peel_to_commit() {
                tips.insert(commit.id().to_string());
            }
        }
        for pattern in ["refs/heads/*", "refs/remotes/*"] {
            let iterator = repository
                .references_glob(pattern)
                .map_err(|_| HistoryError::GitFailed)?;
            for reference in iterator {
                let reference = reference.map_err(|_| HistoryError::GitFailed)?;
                let commit = reference
                    .peel_to_commit()
                    .map_err(|_| HistoryError::GitFailed)?;
                tips.insert(commit.id().to_string());
            }
        }
        Ok(tips.into_iter().collect())
    })
    .await
    .map_err(|_| HistoryError::GitFailed)?
}

/// Adds only the commits that appeared since the last build. Correct only when
/// every previously indexed commit is still reachable and every new commit is
/// strictly newer than the newest indexed one, so that `git log` would list the
/// new commits first, in the order produced here. Returns Ok(false) when those
/// conditions do not hold and a full rebuild is required.
async fn try_prepend_new_commits(
    repo_id: &str,
    repository_path: &Path,
    head: Option<&str>,
    fingerprint: &str,
    tips: &[String],
    old_basis: &HistoryIndexBasis,
    store: Arc<dyn HistorySearchIndexPort>,
) -> Result<bool, HistoryError> {
    if tips.is_empty() {
        return Ok(false);
    }
    let mut lost_arguments: Vec<std::ffi::OsString> =
        vec!["rev-list".into(), "-n".into(), "1".into()];
    lost_arguments.extend(old_basis.tips.iter().map(std::ffi::OsString::from));
    lost_arguments.push("--not".into());
    lost_arguments.extend(tips.iter().map(std::ffi::OsString::from));
    lost_arguments.push("--".into());
    let lost = run_git_bulk_with_deadline(
        repository_path,
        &lost_arguments,
        1024,
        HISTORY_INDEX_DEADLINE,
    )
    .await?;
    if !lost.is_empty() {
        return Ok(false);
    }
    let output = run_git_bulk_with_deadline(
        repository_path,
        &index_log_arguments(false, tips, &old_basis.tips),
        MAX_HISTORY_INDEX_OUTPUT,
        HISTORY_INDEX_DEADLINE,
    )
    .await?;
    let parsed = tokio::task::spawn_blocking(move || parse_history_search_index(&output))
        .await
        .map_err(|_| HistoryError::GitFailed)??;
    if parsed
        .min_commit_time
        .is_some_and(|oldest_new| oldest_new <= old_basis.max_commit_time)
    {
        return Ok(false);
    }
    if refs_fingerprint(repository_path, head).await? != fingerprint {
        // Refs moved while walking; the next lookup schedules another build.
        return Ok(true);
    }
    let basis = HistoryIndexBasis {
        tips: tips.to_vec(),
        max_commit_time: parsed
            .max_commit_time
            .unwrap_or(old_basis.max_commit_time)
            .max(old_basis.max_commit_time),
    };
    let expected_tips = old_basis.tips.clone();
    let entries = parsed.entries;
    let repo_id = repo_id.to_owned();
    let fingerprint = fingerprint.to_owned();
    let added = entries.len();
    let started = std::time::Instant::now();
    let applied = tokio::task::spawn_blocking(move || {
        store.prepend_index(&repo_id, &fingerprint, &expected_tips, basis, entries)
    })
    .await
    .map_err(|_| HistoryError::GitFailed)?
    .map_err(|_| HistoryError::GitFailed)?;
    if applied {
        eprintln!(
            "[gitcrest-core] History index incrementally added {added} commits in {}ms",
            started.elapsed().as_millis()
        );
    }
    Ok(applied)
}

pub(super) async fn refs_fingerprint(
    repository_path: &Path,
    head: Option<&str>,
) -> Result<String, HistoryError> {
    let repository_path = repository_path.to_owned();
    let head = head.map(str::to_owned);
    tokio::task::spawn_blocking(move || refs_fingerprint_sync(&repository_path, head.as_deref()))
        .await
        .map_err(|_| HistoryError::GitFailed)?
}

fn refs_fingerprint_sync(
    repository_path: &Path,
    head: Option<&str>,
) -> Result<String, HistoryError> {
    let repository = Repository::open(repository_path).map_err(|_| HistoryError::GitFailed)?;
    refs_fingerprint_for_repository(&repository, head)
}

fn refs_fingerprint_for_repository(
    repository: &Repository,
    head: Option<&str>,
) -> Result<String, HistoryError> {
    let head_reference = repository.find_reference("HEAD").ok();
    let attached_head = head_reference
        .as_ref()
        .and_then(|reference| reference.symbolic_target_bytes());
    let mut references = Vec::new();
    for pattern in ["refs/heads/*", "refs/remotes/*"] {
        let iterator = repository
            .references_glob(pattern)
            .map_err(|_| HistoryError::GitFailed)?;
        for reference in iterator {
            let reference = reference.map_err(|_| HistoryError::GitFailed)?;
            let name = reference.name_bytes().to_vec();
            let target = reference
                .resolve()
                .map_err(|_| HistoryError::GitFailed)?
                .target()
                .ok_or(HistoryError::GitFailed)?;
            references.push((name, target.to_string()));
        }
    }
    references.sort_unstable_by(|left, right| left.0.cmp(&right.0));

    let mut digest = Sha256::new();
    let attached_head_is_in_refs = attached_head.is_some_and(|head_name| {
        references
            .iter()
            .any(|(name, _)| name.as_slice() == head_name)
    });
    if !attached_head_is_in_refs {
        digest.update(head.unwrap_or_default().as_bytes());
        digest.update([0]);
    }
    for (name, target) in references {
        let is_attached_head = attached_head.is_some_and(|head_name| name.as_slice() == head_name);
        digest.update(name);
        digest.update([0]);
        digest.update(target.as_bytes());
        digest.update([0]);
        if is_attached_head {
            digest.update(b"*\n");
        } else {
            digest.update(b" \n");
        }
    }
    let mut fingerprint = String::with_capacity(64);
    for byte in digest.finalize() {
        write!(fingerprint, "{byte:02x}").map_err(|_| HistoryError::GitFailed)?;
    }
    Ok(fingerprint)
}

struct ParsedHistoryIndex {
    entries: Vec<CommitSearchEntry>,
    min_commit_time: Option<i64>,
    max_commit_time: Option<i64>,
}

fn parse_history_search_index(output: &[u8]) -> Result<ParsedHistoryIndex, HistoryError> {
    let mut fields = output.split(|byte| *byte == 0).peekable();
    let mut parsed = ParsedHistoryIndex {
        entries: Vec::new(),
        min_commit_time: None,
        max_commit_time: None,
    };
    while let Some(oid) = fields.next() {
        if oid.is_empty() && fields.peek().is_none() {
            break;
        }
        if parsed.entries.len() >= 200_000 {
            return Err(HistoryError::TooLarge);
        }
        let commit_time = fields
            .next()
            .and_then(|field| std::str::from_utf8(field).ok())
            .and_then(|field| field.trim().parse::<i64>().ok())
            .ok_or(HistoryError::TooLarge)?;
        let message = fields.next().ok_or(HistoryError::TooLarge)?;
        parsed.min_commit_time = Some(
            parsed
                .min_commit_time
                .map_or(commit_time, |time| time.min(commit_time)),
        );
        parsed.max_commit_time = Some(
            parsed
                .max_commit_time
                .map_or(commit_time, |time| time.max(commit_time)),
        );
        parsed.entries.push(CommitSearchEntry {
            oid: text(oid),
            message: text(message),
        });
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_search_index_records_without_collecting_all_fields() {
        let output = b"oid-1\x00100\0first body\0oid-2\x00200\0second body\0";
        let parsed = parse_history_search_index(output).unwrap();
        assert_eq!(parsed.min_commit_time, Some(100));
        assert_eq!(parsed.max_commit_time, Some(200));
        let entries = parsed.entries;

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].oid, "oid-1");
        assert_eq!(entries[0].message, "first body");
        assert_eq!(entries[1].oid, "oid-2");
    }

    #[test]
    fn rejects_incomplete_search_index_records() {
        assert_eq!(
            parse_history_search_index(b"oid-1\x00100").map(|parsed| parsed.entries.len()),
            Err(HistoryError::TooLarge)
        );
    }
}
