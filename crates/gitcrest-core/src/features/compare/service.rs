use std::{path::Path, process::Stdio, time::Duration};

use tokio::process::Command;

use super::dto::{
    CompareCommit, CompareFile, CompareList, CompareMode, CompareQuery, CompareResult,
};

pub(super) const DEFAULT_LIMIT: usize = 100;
pub(super) const MAX_LIMIT: usize = 500;
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CompareError {
    InvalidRevision,
    UnknownRevision,
    NoCommonAncestor,
    TooLarge,
    GitUnavailable,
    Failed,
}

/// A branch, tag, commit or relative name such as `main~2`, with nothing Git could read as an
/// option, a range or a pathspec.
pub(super) fn validate_revision(value: &str) -> Result<(), CompareError> {
    let bad = value.is_empty()
        || value.len() > 255
        || value.starts_with('-')
        || value.contains("..")
        || value.chars().any(|character| {
            character.is_control() || character.is_whitespace() || ":?*[\\".contains(character)
        });
    if bad {
        Err(CompareError::InvalidRevision)
    } else {
        Ok(())
    }
}

async fn git(
    repository_path: &Path,
    arguments: &[String],
) -> Result<(bool, Vec<u8>), CompareError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository_path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(GIT_TIMEOUT, output).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err(CompareError::GitUnavailable),
        Err(_) => return Err(CompareError::Failed),
    };
    if output.stdout.len() > OUTPUT_LIMIT {
        return Err(CompareError::TooLarge);
    }
    Ok((output.status.success(), output.stdout))
}

async fn resolve(repository_path: &Path, revision: &str) -> Result<String, CompareError> {
    validate_revision(revision)?;
    let arguments = vec![
        "rev-parse".to_owned(),
        "--verify".to_owned(),
        "--quiet".to_owned(),
        "--end-of-options".to_owned(),
        format!("{revision}^{{commit}}"),
    ];
    let (success, output) = git(repository_path, &arguments).await?;
    let oid = String::from_utf8_lossy(&output).trim().to_owned();
    if success && !oid.is_empty() {
        Ok(oid)
    } else {
        Err(CompareError::UnknownRevision)
    }
}

pub(super) fn parse_commits(output: &str) -> Vec<CompareCommit> {
    output
        .split('\0')
        .filter_map(|record| {
            let mut parts = record.trim_start_matches('\n').splitn(4, '\t');
            let oid = parts.next()?;
            let author = parts.next()?;
            let authored = parts.next()?;
            let subject = parts.next().unwrap_or_default();
            (!oid.is_empty()).then(|| CompareCommit {
                oid: oid.to_owned(),
                short_oid: oid.chars().take(7).collect(),
                subject: subject.to_owned(),
                author_name: author.to_owned(),
                authored_at_ms: authored.parse::<i64>().unwrap_or(0) * 1000,
            })
        })
        .collect()
}

/// Commits reachable from `include` but not from `exclude`, newest first.
async fn commits_only_in(
    repository_path: &Path,
    exclude: &str,
    include: &str,
    offset: usize,
    limit: usize,
) -> Result<CompareList<CompareCommit>, CompareError> {
    let arguments = vec![
        "log".to_owned(),
        "-z".to_owned(),
        "--format=%H%x09%an%x09%at%x09%s".to_owned(),
        format!("--skip={offset}"),
        format!("-n{}", limit + 1),
        format!("{exclude}..{include}"),
        "--".to_owned(),
    ];
    let (success, output) = git(repository_path, &arguments).await?;
    if !success {
        return Err(CompareError::Failed);
    }
    let mut items = parse_commits(&String::from_utf8_lossy(&output));
    let has_more = items.len() > limit;
    items.truncate(limit);
    Ok(CompareList { items, has_more })
}

pub(super) fn parse_name_status(output: &str) -> Vec<CompareFile> {
    let mut fields = output.split('\0').filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let letter = status.chars().next().unwrap_or('M');
        let paired = matches!(letter, 'R' | 'C');
        let Some(first) = fields.next() else { break };
        let (path, original_path) = if paired {
            let Some(second) = fields.next() else { break };
            (second.to_owned(), Some(first.to_owned()))
        } else {
            (first.to_owned(), None)
        };
        let kind = match letter {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "copied",
            'T' => "typeChanged",
            _ => "modified",
        };
        files.push(CompareFile {
            path,
            original_path,
            kind,
        });
    }
    files
}

async fn changed_files(
    repository_path: &Path,
    from_oid: &str,
    to_oid: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<CompareList<CompareFile>, CompareError> {
    let mut arguments = vec![
        "diff".to_owned(),
        "--name-status".to_owned(),
        "-z".to_owned(),
        "-M".to_owned(),
        "--no-ext-diff".to_owned(),
        "--no-color".to_owned(),
        from_oid.to_owned(),
    ];
    arguments.extend(to_oid.map(str::to_owned));
    arguments.push("--".to_owned());
    let (success, output) = git(repository_path, &arguments).await?;
    if !success {
        return Err(CompareError::Failed);
    }
    let all = parse_name_status(&String::from_utf8_lossy(&output));
    let has_more = all.len() > offset + limit;
    Ok(CompareList {
        items: all.into_iter().skip(offset).take(limit).collect(),
        has_more,
    })
}

pub(super) async fn compare(
    repo_id: String,
    repository_path: &Path,
    query: CompareQuery,
    limit: usize,
) -> Result<CompareResult, CompareError> {
    let base_oid = resolve(repository_path, &query.base).await?;
    let head_oid = match &query.head {
        Some(head) => Some(resolve(repository_path, head).await?),
        None => None,
    };
    // Against the working tree the commit lists use the checked-out commit.
    let head_side = match &head_oid {
        Some(oid) => oid.clone(),
        None => resolve(repository_path, "HEAD").await?,
    };
    let mode = if head_oid.is_some() {
        query.mode
    } else {
        CompareMode::TwoDot
    };
    let merge_base_arguments = vec!["merge-base".to_owned(), base_oid.clone(), head_side.clone()];
    let (found, merge_base_output) = git(repository_path, &merge_base_arguments).await?;
    let merge_base = String::from_utf8_lossy(&merge_base_output)
        .trim()
        .to_owned();
    let merge_base_oid = (found && !merge_base.is_empty()).then_some(merge_base);
    let from_oid = match (mode, &merge_base_oid) {
        (CompareMode::ThreeDot, Some(ancestor)) => ancestor.clone(),
        (CompareMode::ThreeDot, None) => return Err(CompareError::NoCommonAncestor),
        (CompareMode::TwoDot, _) => base_oid.clone(),
    };
    let (only_in_base, only_in_head, files) = tokio::join!(
        commits_only_in(repository_path, &head_side, &base_oid, query.offset, limit),
        commits_only_in(repository_path, &base_oid, &head_side, query.offset, limit),
        changed_files(
            repository_path,
            &from_oid,
            head_oid.as_deref(),
            query.offset,
            limit
        ),
    );
    Ok(CompareResult {
        repo_id,
        base: query.base,
        head: query.head,
        base_oid,
        head_oid,
        from_oid,
        merge_base_oid,
        mode,
        offset: query.offset,
        limit,
        only_in_base: only_in_base?,
        only_in_head: only_in_head?,
        files: files?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_that_git_could_read_as_more_are_refused() {
        for good in [
            "main",
            "feature/x",
            "v1.0",
            "HEAD~2",
            "origin/main",
            "a1b2c3d",
        ] {
            assert_eq!(validate_revision(good), Ok(()), "{good}");
        }
        for bad in [
            "",
            "-x",
            "--output=a",
            "a..b",
            "a b",
            "a:b",
            "a*",
            "a\\b",
            "a\nb",
        ] {
            assert_eq!(
                validate_revision(bad),
                Err(CompareError::InvalidRevision),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn name_status_output_keeps_renames_paired_and_odd_paths_whole() {
        let files = parse_name_status("M\0a b.txt\0R090\0old.txt\0new.txt\0A\0dir/c\td\0D\0z\0");
        assert_eq!(
            files
                .iter()
                .map(|file| (file.kind, file.path.as_str(), file.original_path.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("modified", "a b.txt", None),
                ("renamed", "new.txt", Some("old.txt")),
                ("added", "dir/c\td", None),
                ("deleted", "z", None),
            ]
        );
    }
}
