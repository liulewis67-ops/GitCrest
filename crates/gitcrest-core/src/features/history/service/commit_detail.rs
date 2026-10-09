use std::path::Path;

use super::{
    parse_timestamp, run_git, split_words, text, CommitDetail, CommitFileStat, CommitStats,
    HistoryError, MAX_HISTORY_OUTPUT,
};

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
