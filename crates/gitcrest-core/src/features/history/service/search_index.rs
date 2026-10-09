use std::{fmt::Write as _, path::Path, sync::Arc};

use git2::Repository;
use sha2::{Digest, Sha256};

use crate::{domain::commit::CommitSearchEntry, ports::history::HistorySearchIndexPort};

use super::commit_history::{read_page, valid_filters};
use super::{
    run_git_with_deadline, text, CommitPage, CommitSummary, HistoryError, HistoryFilters,
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
    let message_only_search = filters.message.is_some()
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
    let fingerprint = if message_only_search
        && filters
            .message
            .as_deref()
            .is_some_and(|message| message.chars().count() >= 3)
    {
        refs_fingerprint(repository_path, head).await.ok()
    } else {
        None
    };

    if let (Some(fingerprint), Some(message)) = (&fingerprint, &filters.message) {
        let store_for_search = store.clone();
        let repo_id_for_search = repo_id.clone();
        let fingerprint_for_search = fingerprint.clone();
        let message_for_search = message.clone();
        let cached = tokio::task::spawn_blocking(move || {
            store_for_search.search_messages(
                &repo_id_for_search,
                &fingerprint_for_search,
                &message_for_search,
                offset,
                limit + 1,
            )
        })
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
        if let Some(mut entries) = cached {
            let has_more = entries.len() > limit;
            if has_more {
                entries.pop();
            }
            let commits = summaries_for_search_entries(repository_path, &entries).await?;
            return Ok(CommitPage {
                repo_id,
                offset,
                limit,
                commits,
                next_offset: has_more.then_some(offset + limit),
                search_pending: false,
            });
        }

        if store.is_index_building(&repo_id)
            || schedule_history_index_build(
                repo_id.clone(),
                repository_path.to_owned(),
                head.map(str::to_owned),
                Some(fingerprint.clone()),
                store.clone(),
            )
        {
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

    if offset == 0 && (message_only_search || unfiltered_first_page) {
        schedule_history_index_build(
            repo_id,
            repository_path.to_owned(),
            head.map(str::to_owned),
            fingerprint,
            store,
        );
    }
    Ok(page)
}

async fn summaries_for_search_entries(
    repository_path: &Path,
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
    let repository_path = repository_path.to_owned();
    let entries = entries.to_vec();
    tokio::task::spawn_blocking(move || {
        let repository = Repository::open(repository_path).map_err(|_| HistoryError::GitFailed)?;
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
    })
    .await
    .map_err(|_| HistoryError::GitFailed)?
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
    claimed
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
    let mut arguments = vec!["log".into(), "-z".into()];
    arguments.push("--format=tformat:%H%x00%B".into());
    if head.is_some() {
        arguments.push("HEAD".into());
    }
    arguments.push("--branches".into());
    arguments.push("--remotes".into());
    let git_started = std::time::Instant::now();
    let output = run_git_with_deadline(
        repository_path,
        &arguments,
        MAX_HISTORY_INDEX_OUTPUT,
        HISTORY_INDEX_DEADLINE,
    )
    .await?;
    let git_elapsed_ms = git_started.elapsed().as_millis();
    let parse_started = std::time::Instant::now();
    let entries = tokio::task::spawn_blocking(move || parse_history_search_index(&output))
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
    let persist_started = std::time::Instant::now();
    let persist_result = match tokio::task::spawn_blocking(move || {
        store.replace_index(&repo_id, &fingerprint, entries)
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

fn parse_history_search_index(output: &[u8]) -> Result<Vec<CommitSearchEntry>, HistoryError> {
    let mut fields = output.split(|byte| *byte == 0).peekable();
    let mut entries = Vec::new();
    while let Some(oid) = fields.next() {
        if oid.is_empty() && fields.peek().is_none() {
            break;
        }
        if entries.len() >= 200_000 {
            return Err(HistoryError::TooLarge);
        }
        let message = fields.next().ok_or(HistoryError::TooLarge)?;
        entries.push(CommitSearchEntry {
            oid: text(oid),
            message: text(message),
        });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_search_index_records_without_collecting_all_fields() {
        let output = b"oid-1\0first body\0oid-2\0second body\0";
        let entries = parse_history_search_index(output).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].oid, "oid-1");
        assert_eq!(entries[0].message, "first body");
        assert_eq!(entries[1].oid, "oid-2");
    }

    #[test]
    fn rejects_incomplete_search_index_records() {
        assert_eq!(
            parse_history_search_index(b"oid-1\0parents\0author"),
            Err(HistoryError::TooLarge)
        );
    }
}
