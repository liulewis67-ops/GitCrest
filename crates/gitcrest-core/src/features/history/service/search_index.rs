use std::{fmt::Write as _, path::Path, sync::Arc};

use sha2::{Digest, Sha256};

use crate::{domain::commit::CommitSearchEntry, ports::history::HistorySearchIndexPort};

use super::commit_history::{read_page, valid_filters};
use super::{
    parse_timestamp, run_git, run_git_with_deadline, split_words, text, CommitPage, CommitSummary,
    HistoryError, HistoryFilters, HISTORY_INDEX_DEADLINE, MAX_HISTORY_INDEX_OUTPUT,
    MAX_HISTORY_OUTPUT,
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
            return Ok(CommitPage {
                repo_id,
                offset,
                limit,
                commits: entries.into_iter().map(summary_from_search_row).collect(),
                next_offset: has_more.then_some(offset + limit),
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

fn summary_from_search_row(row: CommitSearchEntry) -> CommitSummary {
    CommitSummary {
        oid: row.oid,
        parents: row.parents,
        author_name: row.author_name,
        author_email: row.author_email,
        committed_at_ms: row.committed_at_ms,
        subject: row.subject,
    }
}

fn schedule_history_index_build(
    repo_id: String,
    repository_path: std::path::PathBuf,
    head: Option<String>,
    expected_fingerprint: Option<String>,
    store: Arc<dyn HistorySearchIndexPort>,
) {
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let index_fingerprint = match expected_fingerprint {
            Some(fingerprint) => Some(fingerprint),
            None => refs_fingerprint(&repository_path, head.as_deref())
                .await
                .ok(),
        };
        let Some(index_fingerprint) = index_fingerprint else {
            return;
        };
        if !store.begin_index_build(&repo_id, &index_fingerprint) {
            return;
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
        store.finish_index_build(&repo_id);
    });
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
    arguments.push("--format=tformat:%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%B".into());
    if head.is_some() {
        arguments.push("HEAD".into());
    }
    arguments.push("--branches".into());
    arguments.push("--remotes".into());
    let output = run_git_with_deadline(
        repository_path,
        &arguments,
        MAX_HISTORY_INDEX_OUTPUT,
        HISTORY_INDEX_DEADLINE,
    )
    .await?;
    let entries = tokio::task::spawn_blocking(move || parse_history_search_index(&output))
        .await
        .map_err(|_| HistoryError::GitFailed)??;
    let final_fingerprint = refs_fingerprint(repository_path, head).await?;
    if final_fingerprint != fingerprint {
        return Ok(());
    }
    let repo_id = repo_id.to_owned();
    tokio::task::spawn_blocking(move || store.replace_index(&repo_id, &fingerprint, entries))
        .await
        .map_err(|_| HistoryError::GitFailed)?
        .map_err(|_| HistoryError::GitFailed)
}

pub(super) async fn refs_fingerprint(
    repository_path: &Path,
    head: Option<&str>,
) -> Result<String, HistoryError> {
    let refs = run_git(
        repository_path,
        &[
            "for-each-ref".into(),
            "--format=%(refname)%00%(objectname)%00%(HEAD)".into(),
            "refs/heads".into(),
            "refs/remotes".into(),
        ],
        MAX_HISTORY_OUTPUT,
    )
    .await?;
    let mut digest = Sha256::new();
    let attached_head_is_in_refs = refs.windows(3).any(|value| value == b"\0*\n");
    if !attached_head_is_in_refs {
        digest.update(head.unwrap_or_default().as_bytes());
        digest.update([0]);
    }
    digest.update(refs);
    let mut fingerprint = String::with_capacity(64);
    for byte in digest.finalize() {
        write!(fingerprint, "{byte:02x}").map_err(|_| HistoryError::GitFailed)?;
    }
    Ok(fingerprint)
}

fn parse_history_search_index(output: &[u8]) -> Result<Vec<CommitSearchEntry>, HistoryError> {
    let mut fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    if fields.last().is_some_and(|field| field.is_empty()) {
        fields.pop();
    }
    if fields.len() % 7 != 0 || fields.len() / 7 > 200_000 {
        return Err(HistoryError::TooLarge);
    }
    fields
        .chunks_exact(7)
        .enumerate()
        .map(|(sort_order, fields)| {
            Ok(CommitSearchEntry {
                oid: text(fields[0]),
                parents: split_words(fields[1]),
                author_name: text(fields[2]),
                author_email: text(fields[3]),
                committed_at_ms: parse_timestamp(fields[4])?,
                subject: text(fields[5]),
                message: text(fields[6]),
                sort_order,
            })
        })
        .collect()
}
