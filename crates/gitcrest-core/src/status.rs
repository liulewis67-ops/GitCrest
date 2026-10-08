use std::{path::Path, process::Stdio};

use serde::Serialize;
use tokio::process::Command;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub repo_id: String,
    pub refreshed_at_ms: i64,
    pub files: Vec<StatusFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub kind: ChangeKind,
    pub categories: Vec<ChangeCategory>,
    pub mode_changed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Ignored,
    Conflicted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeCategory {
    Staged,
    Unstaged,
    Untracked,
    Ignored,
    Conflicted,
}

pub async fn read(repo_id: String, path: &Path) -> Result<StatusSnapshot, std::io::Error> {
    read_scope(repo_id, path, &[]).await
}

pub async fn read_paths(
    repo_id: String,
    path: &Path,
    paths: &[String],
) -> Result<StatusSnapshot, std::io::Error> {
    if paths.is_empty()
        || paths.len() > 256
        || paths.iter().any(|path| {
            path.is_empty()
                || path.len() > 4096
                || Path::new(path).is_absolute()
                || Path::new(path).components().any(|component| {
                    matches!(
                        component,
                        std::path::Component::ParentDir | std::path::Component::RootDir
                    )
                })
        })
        || paths.iter().map(String::len).sum::<usize>() > 64 * 1024
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "The status path scope is invalid or too large",
        ));
    }
    read_scope(repo_id, path, paths).await
}

async fn read_scope(
    repo_id: String,
    path: &Path,
    paths: &[String],
) -> Result<StatusSnapshot, std::io::Error> {
    let mut command = Command::new("git");
    command
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(path)
        .args([
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if !paths.is_empty() {
        command.arg("--").args(paths);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "Git status timed out"))??;

    if !output.status.success() {
        return Err(std::io::Error::other("Git status failed"));
    }

    Ok(StatusSnapshot {
        repo_id,
        refreshed_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64,
        files: parse_porcelain_v2(&output.stdout),
    })
}

fn parse_porcelain_v2(output: &[u8]) -> Vec<StatusFile> {
    let output = String::from_utf8_lossy(output);
    let mut records = output
        .split('\0')
        .filter(|record| !record.is_empty())
        .peekable();
    let mut files = Vec::new();

    while let Some(record) = records.next() {
        if record.starts_with("2 ") {
            if let Some(original_path) = records.next() {
                if let Some(file) = parse_record(record, Some(original_path.to_owned())) {
                    files.push(file);
                }
            }
        } else if let Some(file) = parse_record(record, None) {
            files.push(file);
        }
    }
    files
}

fn parse_record(record: &str, original_path: Option<String>) -> Option<StatusFile> {
    let (kind_tag, status, mode_changed, path) = match record.as_bytes().first().copied()? {
        b'1' => {
            let fields = record.splitn(9, ' ').collect::<Vec<_>>();
            if fields.len() != 9 {
                return None;
            }
            (
                fields[0],
                fields[1],
                fields[3] != fields[4] || fields[4] != fields[5],
                fields[8],
            )
        }
        b'2' => {
            let fields = record.splitn(10, ' ').collect::<Vec<_>>();
            if fields.len() != 10 {
                return None;
            }
            (
                fields[0],
                fields[1],
                fields[3] != fields[4] || fields[4] != fields[5],
                fields[9],
            )
        }
        b'u' => {
            let fields = record.splitn(11, ' ').collect::<Vec<_>>();
            if fields.len() != 11 {
                return None;
            }
            (
                fields[0],
                fields[1],
                fields[3] != fields[4] || fields[4] != fields[5] || fields[5] != fields[6],
                fields[10],
            )
        }
        b'?' => {
            return Some(special_file(
                record,
                ChangeKind::Untracked,
                ChangeCategory::Untracked,
            ))
        }
        b'!' => {
            return Some(special_file(
                record,
                ChangeKind::Ignored,
                ChangeCategory::Ignored,
            ))
        }
        _ => return None,
    };

    let mut status_chars = status.chars();
    let index_status = status_chars.next().unwrap_or('.');
    let worktree_status = status_chars.next().unwrap_or('.');
    let conflicted = kind_tag == "u" || status.contains('U');
    let kind = if conflicted {
        ChangeKind::Conflicted
    } else {
        change_kind(index_status, worktree_status)
    };
    let mut categories = Vec::new();
    if conflicted {
        categories.push(ChangeCategory::Conflicted);
    } else {
        if index_status != '.' {
            categories.push(ChangeCategory::Staged);
        }
        if worktree_status != '.' {
            categories.push(ChangeCategory::Unstaged);
        }
    }

    Some(StatusFile {
        path: path.to_owned(),
        original_path,
        index_status: index_status.to_string(),
        worktree_status: worktree_status.to_string(),
        kind,
        categories,
        mode_changed,
    })
}

fn special_file(record: &str, kind: ChangeKind, category: ChangeCategory) -> StatusFile {
    StatusFile {
        path: record.get(2..).unwrap_or_default().to_owned(),
        original_path: None,
        index_status: if category == ChangeCategory::Untracked {
            "?"
        } else {
            "!"
        }
        .into(),
        worktree_status: if category == ChangeCategory::Untracked {
            "?"
        } else {
            "!"
        }
        .into(),
        kind,
        categories: vec![category],
        mode_changed: false,
    }
}

fn change_kind(index: char, worktree: char) -> ChangeKind {
    let statuses = [index, worktree];
    if statuses.contains(&'R') {
        ChangeKind::Renamed
    } else if statuses.contains(&'C') {
        ChangeKind::Copied
    } else if statuses.contains(&'D') {
        ChangeKind::Deleted
    } else if statuses.contains(&'T') {
        ChangeKind::TypeChanged
    } else if statuses.contains(&'A') {
        ChangeKind::Added
    } else {
        ChangeKind::Modified
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2_groups_renames_conflicts_and_mode_changes() {
        let records = concat!(
            "1 M. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 both.txt\0",
            "2 R. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R100 renamed.txt\0old name.txt\0",
            "u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 conflict.txt\0",
            "1 M. N... 100644 100755 100755 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 executable.sh\0",
            "? new file.txt\0",
            "! ignored.log\0",
        );
        let files = parse_porcelain_v2(records.as_bytes());

        assert_eq!(files.len(), 6);
        assert_eq!(files[0].categories, [ChangeCategory::Staged]);
        assert_eq!(files[1].kind, ChangeKind::Renamed);
        assert_eq!(files[1].original_path.as_deref(), Some("old name.txt"));
        assert_eq!(files[2].kind, ChangeKind::Conflicted);
        assert_eq!(files[2].categories, [ChangeCategory::Conflicted]);
        assert!(files[3].mode_changed);
        assert_eq!(files[4].categories, [ChangeCategory::Untracked]);
        assert_eq!(files[5].categories, [ChangeCategory::Ignored]);
    }
}
