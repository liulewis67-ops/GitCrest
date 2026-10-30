use std::{collections::HashMap, collections::HashSet, path::Path, process::Stdio, time::Duration};

use tokio::process::Command;

use super::{
    dto::{TagEntry, TagPage},
    service::TagError,
};

pub(super) const DEFAULT_LIMIT: usize = 100;
pub(super) const MAX_LIMIT: usize = 500;
const MAX_TARGETS: usize = 200;
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
// Names and targets only: reading tag objects for every tag is what makes huge tag sets slow, and
// packed refs already carry the peeled commit of an annotated tag.
const NAMES_FORMAT: &str = "%(refname:short)%09%(objectname)%09%(*objectname)";
const DETAIL_FORMAT: &str =
    "%(refname:short)%09%(taggername)%09%(creatordate:unix)%09%(contents:subject)";

struct NamedTag {
    name: String,
    target_oid: String,
    annotated: bool,
}

fn parse_name_line(line: &str) -> Option<NamedTag> {
    let mut parts = line.splitn(3, '\t');
    let name = parts.next()?;
    let object = parts.next()?;
    let peeled = parts.next().unwrap_or_default();
    let annotated = !peeled.is_empty();
    let target = if annotated { peeled } else { object };
    (!name.is_empty() && !target.is_empty()).then(|| NamedTag {
        name: name.to_owned(),
        target_oid: target.to_owned(),
        annotated,
    })
}

struct TagDetail {
    tagger_name: Option<String>,
    created_at_ms: Option<i64>,
    message: Option<String>,
}

fn parse_detail_line(line: &str) -> Option<(String, TagDetail)> {
    let mut parts = line.splitn(4, '\t');
    let name = parts.next()?;
    let tagger = parts.next()?;
    let created = parts.next()?;
    let subject = parts.next().unwrap_or_default();
    Some((
        name.to_owned(),
        TagDetail {
            tagger_name: (!tagger.is_empty()).then(|| tagger.to_owned()),
            created_at_ms: created.parse::<i64>().ok().map(|seconds| seconds * 1000),
            message: (!subject.is_empty()).then(|| subject.to_owned()),
        },
    ))
}

async fn run_for_each_ref(
    repository_path: &Path,
    arguments: &[String],
) -> Result<String, TagError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository_path)
        .arg("for-each-ref")
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(LIST_TIMEOUT, output).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err(TagError::GitUnavailable),
        Err(_) => return Err(TagError::TimedOut),
    };
    if !output.status.success() || output.stdout.len() > OUTPUT_LIMIT {
        return Err(TagError::GitFailed);
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Tags newest version first. Matching and paging use names and targets only; the tagger, date and
/// message are read for the annotated tags of the returned page.
pub(super) async fn list(
    repo_id: String,
    repository_path: &Path,
    offset: usize,
    limit: usize,
    filter: Option<&str>,
    targets: Option<&str>,
) -> Result<TagPage, TagError> {
    let target_set: Option<HashSet<String>> = match targets {
        Some(value) => {
            let set: HashSet<String> = value
                .split(',')
                .map(|item| item.trim().to_ascii_lowercase())
                .filter(|item| !item.is_empty())
                .collect();
            if set.len() > MAX_TARGETS
                || set
                    .iter()
                    .any(|oid| !oid.bytes().all(|byte| byte.is_ascii_hexdigit()))
            {
                return Err(TagError::Invalid);
            }
            Some(set)
        }
        None => None,
    };
    let needle = filter
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let names = run_for_each_ref(
        repository_path,
        &[
            "--sort=-version:refname".to_owned(),
            format!("--format={NAMES_FORMAT}"),
            "refs/tags".to_owned(),
        ],
    )
    .await?;
    let mut matching = names
        .lines()
        .filter_map(parse_name_line)
        .filter(|tag| {
            needle
                .as_ref()
                .is_none_or(|needle| tag.name.to_lowercase().contains(needle))
        })
        .filter(|tag| {
            target_set
                .as_ref()
                .is_none_or(|set| set.contains(&tag.target_oid.to_ascii_lowercase()))
        })
        .skip(offset);
    let page: Vec<NamedTag> = matching.by_ref().take(limit).collect();
    let next_offset = matching.next().map(|_| offset + limit);

    let annotated_refs: Vec<String> = page
        .iter()
        .filter(|tag| tag.annotated)
        .map(|tag| format!("refs/tags/{}", tag.name))
        .collect();
    let mut details: HashMap<String, TagDetail> = HashMap::new();
    if !annotated_refs.is_empty() {
        let mut arguments = vec![format!("--format={DETAIL_FORMAT}")];
        arguments.extend(annotated_refs);
        details = run_for_each_ref(repository_path, &arguments)
            .await?
            .lines()
            .filter_map(parse_detail_line)
            .collect();
    }
    let tags = page
        .into_iter()
        .map(|tag| {
            let detail = details.remove(&tag.name);
            TagEntry {
                name: tag.name,
                target_oid: tag.target_oid,
                annotated: tag.annotated,
                tagger_name: detail
                    .as_ref()
                    .and_then(|detail| detail.tagger_name.clone()),
                created_at_ms: detail.as_ref().and_then(|detail| detail.created_at_ms),
                message: detail.and_then(|detail| detail.message),
            }
        })
        .collect();
    Ok(TagPage {
        repo_id,
        offset,
        limit,
        tags,
        next_offset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_annotated_from_lightweight_by_the_peeled_target() {
        let commit = "a".repeat(40);
        let tag_object = "b".repeat(40);
        let lightweight = parse_name_line(&format!("v1\t{commit}\t")).unwrap();
        assert!(!lightweight.annotated);
        assert_eq!(lightweight.target_oid, commit);

        let annotated = parse_name_line(&format!("v2\t{tag_object}\t{commit}")).unwrap();
        assert!(annotated.annotated);
        assert_eq!(annotated.target_oid, commit);
        assert!(parse_name_line("\t\t").is_none());
    }

    #[test]
    fn keeps_tabs_in_a_tag_subject() {
        let (name, detail) = parse_detail_line("v2\tAda\t200\tRelease\ttwo").unwrap();
        assert_eq!(name, "v2");
        assert_eq!(detail.tagger_name.as_deref(), Some("Ada"));
        assert_eq!(detail.created_at_ms, Some(200_000));
        assert_eq!(detail.message.as_deref(), Some("Release\ttwo"));
    }
}
