use std::{collections::HashMap, path::Path, process::Stdio, time::Duration};

use tokio::process::Command;

use super::dto::{SubmoduleEntry, SubmoduleState};

const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const MAX_SUBMODULES: usize = 500;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SubmoduleError {
    /// A path in the request is not one of this repository's submodules.
    UnknownPath,
    GitUnavailable,
    Failed,
}

async fn git(
    working_directory: &Path,
    arguments: &[&str],
) -> Result<(bool, Vec<u8>), SubmoduleError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(working_directory)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(GIT_TIMEOUT, output).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err(SubmoduleError::GitUnavailable),
        Err(_) => return Err(SubmoduleError::Failed),
    };
    if output.stdout.len() > OUTPUT_LIMIT {
        return Err(SubmoduleError::Failed);
    }
    Ok((output.status.success(), output.stdout))
}

/// A relative path inside the repository, as `.gitmodules` is supposed to hold; anything else is
/// not trusted enough to hand to Git or to join onto the repository path.
pub(super) fn is_safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.starts_with('/')
        && !path.starts_with('-')
        && !path.contains('\\')
        && !path.contains(':')
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && part != ".git")
}

/// `(name, path, url)` for each submodule `.gitmodules` declares. Read with `-z`, so values with
/// newlines or odd characters stay whole.
pub(super) fn parse_gitmodules(output: &str) -> Vec<(String, String, Option<String>)> {
    let mut paths: Vec<String> = Vec::new();
    let mut by_name: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for record in output.split('\0').filter(|record| !record.is_empty()) {
        let Some((key, value)) = record.split_once('\n') else {
            continue;
        };
        let Some(rest) = key.strip_prefix("submodule.") else {
            continue;
        };
        let Some((name, field)) = rest.rsplit_once('.') else {
            continue;
        };
        let entry = by_name.entry(name.to_owned()).or_default();
        match field {
            "path" => {
                entry.0 = Some(value.to_owned());
                if !paths.contains(&name.to_owned()) {
                    paths.push(name.to_owned());
                }
            }
            "url" => entry.1 = Some(value.to_owned()),
            _ => {}
        }
    }
    paths
        .into_iter()
        .filter_map(|name| {
            let (path, url) = by_name.remove(&name)?;
            Some((name, path?, url))
        })
        .collect()
}

/// `(stage, oid)` for each gitlink in `ls-files -s -z` output, by path. A conflicted path has
/// several stages; stage 0 wins when present.
pub(super) fn parse_index_gitlinks(output: &str) -> HashMap<String, (u8, String)> {
    let mut links: HashMap<String, (u8, String)> = HashMap::new();
    for record in output.split('\0').filter(|record| !record.is_empty()) {
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        let mut parts = meta.split(' ');
        let (Some(mode), Some(oid), Some(stage)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if mode != "160000" {
            continue;
        }
        let stage: u8 = stage.parse().unwrap_or(0);
        links
            .entry(path.to_owned())
            .and_modify(|current| {
                if stage == 0 || current.0 != 0 && stage < current.0 {
                    *current = (stage, oid.to_owned());
                }
            })
            .or_insert((stage, oid.to_owned()));
    }
    links
}

/// `path -> oid` for gitlinks in `ls-tree -z` output.
pub(super) fn parse_tree_gitlinks(output: &str) -> HashMap<String, String> {
    output
        .split('\0')
        .filter_map(|record| {
            let (meta, path) = record.split_once('\t')?;
            let mut parts = meta.split(' ');
            let (mode, _kind, oid) = (parts.next()?, parts.next()?, parts.next()?);
            (mode == "160000").then(|| (path.to_owned(), oid.to_owned()))
        })
        .collect()
}

async fn checked_out_oid(repository_path: &Path, path: &str) -> Option<String> {
    let directory = repository_path.join(path);
    // A submodule's `.git` is a file pointing at the superproject's modules folder, or a folder.
    if tokio::fs::symlink_metadata(directory.join(".git"))
        .await
        .is_err()
    {
        return None;
    }
    let (success, output) = git(&directory, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .await
        .ok()?;
    let oid = String::from_utf8_lossy(&output).trim().to_owned();
    (success && !oid.is_empty()).then_some(oid)
}

/// The submodules `.gitmodules` declares that the index also has as gitlinks.
pub(super) async fn list(repository_path: &Path) -> Result<Vec<SubmoduleEntry>, SubmoduleError> {
    if tokio::fs::symlink_metadata(repository_path.join(".gitmodules"))
        .await
        .map(|metadata| !metadata.is_file())
        .unwrap_or(true)
    {
        return Ok(Vec::new());
    }
    let (success, config) = git(
        repository_path,
        &[
            "config",
            "--file",
            ".gitmodules",
            "-z",
            "--get-regexp",
            r"^submodule\..*\.(path|url)$",
        ],
    )
    .await?;
    // Exit code 1 only means that nothing matched.
    let declared: Vec<_> = if success {
        parse_gitmodules(&String::from_utf8_lossy(&config))
            .into_iter()
            .filter(|(_, path, _)| is_safe_path(path))
            .take(MAX_SUBMODULES)
            .collect()
    } else {
        Vec::new()
    };
    if declared.is_empty() {
        return Ok(Vec::new());
    }
    let mut stage_arguments = vec!["--literal-pathspecs", "ls-files", "-s", "-z", "--"];
    let mut tree_arguments = vec!["--literal-pathspecs", "ls-tree", "-z", "HEAD", "--"];
    for (_, path, _) in &declared {
        stage_arguments.push(path);
        tree_arguments.push(path);
    }
    let (staged_ok, staged) = git(repository_path, &stage_arguments).await?;
    if !staged_ok {
        return Err(SubmoduleError::Failed);
    }
    let links = parse_index_gitlinks(&String::from_utf8_lossy(&staged));
    // A repository without commits has no HEAD tree to read.
    let committed = match git(repository_path, &tree_arguments).await {
        Ok((true, tree)) => parse_tree_gitlinks(&String::from_utf8_lossy(&tree)),
        _ => HashMap::new(),
    };
    // One process per submodule, run side by side.
    let handles: Vec<_> = declared
        .iter()
        .map(|(_, path, _)| {
            let repository_path = repository_path.to_owned();
            let path = path.clone();
            tokio::spawn(async move { checked_out_oid(&repository_path, &path).await })
        })
        .collect();
    let mut checked_out = Vec::with_capacity(handles.len());
    for handle in handles {
        checked_out.push(handle.await.ok().flatten());
    }
    let mut items: Vec<SubmoduleEntry> = declared
        .into_iter()
        .zip(checked_out)
        .filter_map(|((name, path, url), checked_out_oid)| {
            let (stage, recorded) = links.get(&path)?.clone();
            let state = if stage != 0 {
                SubmoduleState::Conflicted
            } else {
                match &checked_out_oid {
                    None => SubmoduleState::Uninitialized,
                    Some(oid) if *oid == recorded => SubmoduleState::UpToDate,
                    Some(_) => SubmoduleState::OutOfDate,
                }
            };
            Some(SubmoduleEntry {
                name,
                committed_oid: committed.get(&path).cloned(),
                path,
                url,
                recorded_oid: Some(recorded),
                checked_out_oid,
                state,
            })
        })
        .collect();
    items.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_relative_paths_are_trusted() {
        for good in ["lib", "vendor/lib", "a b/c", "dir.with.dots/x"] {
            assert!(is_safe_path(good), "{good}");
        }
        for bad in [
            "", "/abs", "../x", "a/../b", "a//b", "./a", "-x", "a/.git", "C:/x", "a\\b", "a\nb",
        ] {
            assert!(!is_safe_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn gitmodules_output_pairs_name_path_and_url_even_with_dots_in_the_name() {
        let parsed = parse_gitmodules(
            "submodule.libs/a.b.path\nlibs/a.b\0submodule.libs/a.b.url\nhttps://example.invalid/a.b.git\0submodule.only.path\nonly\0",
        );
        assert_eq!(
            parsed,
            vec![
                (
                    "libs/a.b".to_owned(),
                    "libs/a.b".to_owned(),
                    Some("https://example.invalid/a.b.git".to_owned())
                ),
                ("only".to_owned(), "only".to_owned(), None),
            ]
        );
    }

    #[test]
    fn index_and_tree_gitlinks_are_read_by_path_and_conflicts_are_flagged() {
        let links = parse_index_gitlinks(
            "160000 aaaa 0\tone\x00100644 bbbb 0\tfile\x00160000 cccc 1\ttwo\x00160000 dddd 2\ttwo\0",
        );
        assert_eq!(links["one"], (0, "aaaa".to_owned()));
        assert_eq!(links["two"].0, 1);
        assert!(!links.contains_key("file"));
        let tree = parse_tree_gitlinks("160000 commit eeee\tone\x00100644 blob ffff\tfile\0");
        assert_eq!(tree["one"], "eeee");
        assert_eq!(tree.len(), 1);
    }
}
