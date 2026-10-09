use std::path::{Component, Path};

use super::{run_git, text, BlameDocument, BlameLine, HistoryError, MAX_HISTORY_OUTPUT};

pub async fn read_blame(
    repo_id: String,
    repository_path: &Path,
    relative_path: &str,
    revision: Option<&str>,
) -> Result<BlameDocument, HistoryError> {
    if !valid_repo_relative_path(relative_path)
        || revision.is_some_and(|oid| {
            !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(HistoryError::InvalidQuery);
    }
    if let Some(revision) = revision {
        match run_git(
            repository_path,
            &["cat-file".into(), "-t".into(), revision.into()],
            1024,
        )
        .await
        {
            Ok(kind) if kind == b"commit\n" || kind == b"commit" => {}
            Ok(_) | Err(HistoryError::GitFailed) => return Err(HistoryError::CommitNotFound),
            Err(error) => return Err(error),
        }
    }
    let mut arguments = vec![
        "blame".into(),
        "--line-porcelain".into(),
        "--no-progress".into(),
    ];
    if let Some(revision) = revision {
        arguments.push(revision.into());
    }
    arguments.push("--".into());
    arguments.push(relative_path.into());
    let output = run_git(repository_path, &arguments, MAX_HISTORY_OUTPUT).await?;
    Ok(BlameDocument {
        repo_id,
        path: relative_path.to_owned(),
        revision: revision.map(str::to_owned),
        lines: parse_blame(&output)?,
    })
}

fn valid_repo_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.chars().any(char::is_control)
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn parse_blame(output: &[u8]) -> Result<Vec<BlameLine>, HistoryError> {
    let mut lines = output.split(|byte| *byte == b'\n').peekable();
    let mut result = Vec::new();
    while let Some(header) = lines.next() {
        if header.is_empty() {
            continue;
        }
        let fields = std::str::from_utf8(header).map_err(|_| HistoryError::GitFailed)?;
        let mut fields = fields.split_whitespace();
        let commit_oid = fields
            .next()
            .ok_or(HistoryError::GitFailed)?
            .trim_start_matches('^');
        let original_line_number = fields
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or(HistoryError::GitFailed)?;
        let line_number = fields
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or(HistoryError::GitFailed)?;
        if !matches!(commit_oid.len(), 40 | 64)
            || !commit_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(HistoryError::GitFailed);
        }
        let mut author_name = None;
        let mut author_email = None;
        let mut author_time = None;
        let mut summary = None;
        let content = loop {
            let metadata = lines.next().ok_or(HistoryError::GitFailed)?;
            if let Some(content) = metadata.strip_prefix(b"\t") {
                break content;
            }
            if let Some(value) = metadata.strip_prefix(b"author ") {
                author_name = Some(text(value));
            } else if let Some(value) = metadata.strip_prefix(b"author-mail <") {
                author_email = Some(text(value.strip_suffix(b">").unwrap_or(value)));
            } else if let Some(value) = metadata.strip_prefix(b"author-time ") {
                author_time = std::str::from_utf8(value)
                    .ok()
                    .and_then(|value| value.parse::<i64>().ok());
            } else if let Some(value) = metadata.strip_prefix(b"summary ") {
                summary = Some(text(value));
            }
        };
        result.push(BlameLine {
            line_number,
            original_line_number,
            commit_oid: commit_oid.to_owned(),
            author_name: author_name.ok_or(HistoryError::GitFailed)?,
            author_email: author_email.ok_or(HistoryError::GitFailed)?,
            committed_at_ms: author_time
                .and_then(|seconds| seconds.checked_mul(1000))
                .ok_or(HistoryError::GitFailed)?,
            summary: summary.ok_or(HistoryError::GitFailed)?,
            text: text(content.strip_suffix(b"\r").unwrap_or(content)),
        });
    }
    Ok(result)
}
