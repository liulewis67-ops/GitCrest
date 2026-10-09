use std::path::Path;

use super::{
    parse_timestamp, read_refs, run_git, split_words, text, CommitPage, CommitSummary,
    HistoryError, HistoryFilters, MAX_HISTORY_OUTPUT,
};

pub(super) async fn read_page(
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

pub(super) fn valid_filters(filters: &HistoryFilters) -> bool {
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

pub(super) fn valid_date(value: &str) -> bool {
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
