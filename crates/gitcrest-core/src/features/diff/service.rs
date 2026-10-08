use std::{
    path::{Component, Path},
    process::Stdio,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::status::{ChangeCategory, ChangeKind, StatusFile};

const MAX_DIFF_BYTES: usize = 10 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 16 * 1024;
const DIFF_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Deserialize, Hash, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope {
    WorkingTree,
    Index,
    Commit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffContentStatus {
    Text,
    Binary,
    Empty,
    Conflicted,
    Ignored,
    Symlink,
    Submodule,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffRowKind {
    Context,
    Change,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub kind: DiffRowKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    #[serde(skip)]
    patch_change_lines: Vec<usize>,
    #[serde(skip)]
    old_position: Option<u32>,
    #[serde(skip)]
    new_position: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub rows: Vec<DiffRow>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSelection {
    pub hunk_index: usize,
    #[serde(default)]
    pub row_index: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffDocument {
    pub repo_id: String,
    pub path: String,
    pub revision: String,
    pub original_path: Option<String>,
    pub scope: DiffScope,
    pub change_kind: ChangeKind,
    pub status: DiffContentStatus,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DiffError {
    InvalidPath,
    PathNotFound,
    PermissionDenied,
    TooLarge,
    TimedOut,
    GitUnavailable,
    GitFailed,
}

pub struct DiffRead {
    pub document: DiffDocument,
    pub patch: Vec<u8>,
}

#[derive(Debug)]
enum RawLine {
    Addition {
        text: String,
        line: u32,
        old_position: u32,
        new_position: u32,
        patch_line: usize,
    },
    Deletion {
        text: String,
        line: u32,
        old_position: u32,
        new_position: u32,
        patch_line: usize,
    },
}

pub async fn read(
    repo_id: String,
    repository_path: &Path,
    file: &StatusFile,
    scope: DiffScope,
) -> Result<DiffDocument, DiffError> {
    read_with_patch(repo_id, repository_path, file, scope)
        .await
        .map(|result| result.document)
}

pub async fn read_commit_file(
    repo_id: String,
    repository_path: &Path,
    oid: &str,
    parent_oid: Option<&str>,
    relative_path: &str,
) -> Result<DiffDocument, DiffError> {
    validate_repo_relative_path(relative_path)?;
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(DiffError::InvalidPath);
    }
    let mut command = Command::new("git");
    command.arg("-C").arg(repository_path).args([
        "--literal-pathspecs",
        if parent_oid.is_some() {
            "diff"
        } else {
            "diff-tree"
        },
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
    ]);
    if let Some(parent_oid) = parent_oid {
        command.arg(parent_oid).arg(oid);
    } else {
        command.args(["--root", "--no-commit-id", "-p", "-r", oid]);
    }
    command
        .arg("--")
        .arg(relative_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_PAGER", "cat")
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| DiffError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(DiffError::GitFailed)?;
    let stderr = child.stderr.take().ok_or(DiffError::GitFailed)?;
    let stdout_reader = tokio::spawn(read_capped(stdout, MAX_DIFF_BYTES));
    let stderr_reader = tokio::spawn(read_capped(stderr, MAX_ERROR_BYTES));
    let result = tokio::time::timeout(DIFF_DEADLINE, async {
        let status = child.wait().await.map_err(|_| DiffError::GitFailed)?;
        let stdout = stdout_reader
            .await
            .map_err(|_| DiffError::GitFailed)?
            .map_err(|_| DiffError::GitFailed)?;
        let stderr = stderr_reader
            .await
            .map_err(|_| DiffError::GitFailed)?
            .map_err(|_| DiffError::GitFailed)?;
        Ok::<_, DiffError>((status, stdout, stderr))
    })
    .await;
    let (status, stdout, stderr) = match result {
        Ok(result) => result?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(DiffError::TimedOut);
        }
    };
    if stdout.overflowed {
        return Err(DiffError::TooLarge);
    }
    if !status.success() {
        return Err(classify_git_error(
            &String::from_utf8_lossy(&stderr.bytes).to_ascii_lowercase(),
        ));
    }
    let parsed = parse_diff(&stdout.bytes);
    let mut document = DiffDocument {
        repo_id,
        path: relative_path.to_owned(),
        revision: revision_for(DiffScope::Commit, relative_path, &stdout.bytes),
        original_path: None,
        scope: DiffScope::Commit,
        change_kind: ChangeKind::Modified,
        status: if parsed.binary {
            DiffContentStatus::Binary
        } else if parsed.hunks.is_empty() {
            DiffContentStatus::Empty
        } else {
            DiffContentStatus::Text
        },
        hunks: parsed.hunks,
    };
    if document.status == DiffContentStatus::Empty {
        document.hunks.clear();
    }
    Ok(document)
}

pub async fn read_with_patch(
    repo_id: String,
    repository_path: &Path,
    file: &StatusFile,
    scope: DiffScope,
) -> Result<DiffRead, DiffError> {
    validate_repo_relative_path(&file.path)?;
    let mut document = DiffDocument {
        repo_id,
        path: file.path.clone(),
        revision: revision_for(scope, &file.path, &[]),
        original_path: file.original_path.clone(),
        scope,
        change_kind: file.kind.clone(),
        status: DiffContentStatus::Empty,
        hunks: Vec::new(),
    };

    if file.categories.contains(&ChangeCategory::Conflicted) {
        document.status = DiffContentStatus::Conflicted;
        return Ok(DiffRead {
            document,
            patch: Vec::new(),
        });
    }
    if file.categories.contains(&ChangeCategory::Ignored) {
        document.status = DiffContentStatus::Ignored;
        return Ok(DiffRead {
            document,
            patch: Vec::new(),
        });
    }
    if scope == DiffScope::Index && !file.categories.contains(&ChangeCategory::Staged) {
        return Ok(DiffRead {
            document,
            patch: Vec::new(),
        });
    }
    if scope == DiffScope::WorkingTree
        && !file.categories.iter().any(|category| {
            matches!(
                category,
                ChangeCategory::Unstaged | ChangeCategory::Untracked
            )
        })
    {
        return Ok(DiffRead {
            document,
            patch: Vec::new(),
        });
    }

    let file_path = inspect_path(repository_path, &file.path).await?;
    match file_path {
        FilePathState::Symlink => {
            document.status = DiffContentStatus::Symlink;
            return Ok(DiffRead {
                document,
                patch: Vec::new(),
            });
        }
        FilePathState::Submodule => {
            document.status = DiffContentStatus::Submodule;
            return Ok(DiffRead {
                document,
                patch: Vec::new(),
            });
        }
        FilePathState::Regular | FilePathState::Missing => {}
    }

    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args([
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=3",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_PAGER", "cat")
        .kill_on_drop(true);
    if scope == DiffScope::Index {
        command.arg("--cached");
    } else if file.categories.contains(&ChangeCategory::Untracked) {
        command.arg("--no-index");
    }
    command.arg("--");
    if scope == DiffScope::WorkingTree && file.categories.contains(&ChangeCategory::Untracked) {
        command.arg("/dev/null");
    }
    command.arg(&file.path);

    let mut child = command.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => DiffError::GitUnavailable,
        std::io::ErrorKind::PermissionDenied => DiffError::PermissionDenied,
        _ => DiffError::GitUnavailable,
    })?;
    let stdout = child.stdout.take().ok_or(DiffError::GitFailed)?;
    let stderr = child.stderr.take().ok_or(DiffError::GitFailed)?;
    let stdout_reader = tokio::spawn(read_capped(stdout, MAX_DIFF_BYTES));
    let stderr_reader = tokio::spawn(read_capped(stderr, MAX_ERROR_BYTES));
    let result = tokio::time::timeout(DIFF_DEADLINE, async {
        let status = child.wait().await.map_err(|_| DiffError::GitFailed)?;
        let stdout = stdout_reader
            .await
            .map_err(|_| DiffError::GitFailed)?
            .map_err(|_| DiffError::GitFailed)?;
        let stderr = stderr_reader
            .await
            .map_err(|_| DiffError::GitFailed)?
            .map_err(|_| DiffError::GitFailed)?;
        Ok::<_, DiffError>((status, stdout, stderr))
    })
    .await;
    let (status, stdout, stderr) = match result {
        Ok(result) => result?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(DiffError::TimedOut);
        }
    };
    if stdout.overflowed {
        return Err(DiffError::TooLarge);
    }
    let expected_no_index_diff =
        scope == DiffScope::WorkingTree && file.categories.contains(&ChangeCategory::Untracked);
    if !(status.success() || (expected_no_index_diff && status.code() == Some(1))) {
        let error = String::from_utf8_lossy(&stderr.bytes).to_ascii_lowercase();
        return Err(classify_git_error(&error));
    }
    document.revision = revision_for(scope, &file.path, &stdout.bytes);
    let parsed = parse_diff(&stdout.bytes);
    document.status = if parsed.binary {
        DiffContentStatus::Binary
    } else if parsed.hunks.is_empty() {
        DiffContentStatus::Empty
    } else {
        DiffContentStatus::Text
    };
    document.hunks = parsed.hunks;
    Ok(DiffRead {
        document,
        patch: stdout.bytes,
    })
}

fn revision_for(scope: DiffScope, path: &str, patch: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(match scope {
        DiffScope::WorkingTree => b"workingTree\0".as_slice(),
        DiffScope::Index => b"index\0".as_slice(),
        DiffScope::Commit => b"commit\0".as_slice(),
    });
    hash.update(path.as_bytes());
    hash.update([0]);
    hash.update(patch);
    format!("sha256:{:x}", hash.finalize())
}

pub fn select_hunks(read: &DiffRead, selected: &[usize]) -> Result<Vec<u8>, DiffError> {
    if selected.is_empty() || read.document.status != DiffContentStatus::Text {
        return Err(DiffError::InvalidPath);
    }
    let requested_count = selected.len();
    let selected = selected
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if selected.len() != requested_count
        || selected
            .iter()
            .any(|index| *index >= read.document.hunks.len())
    {
        return Err(DiffError::InvalidPath);
    }
    let text = String::from_utf8_lossy(&read.patch);
    let mut prefix = Vec::new();
    let mut hunks = Vec::<Vec<u8>>::new();
    let mut current: Option<Vec<u8>> = None;
    for line in text.split_inclusive('\n') {
        if parse_hunk_header(line.trim_end_matches(['\r', '\n'])).is_some() {
            if let Some(hunk) = current.take() {
                hunks.push(hunk);
            }
            current = Some(line.as_bytes().to_vec());
        } else if let Some(hunk) = current.as_mut() {
            hunk.extend_from_slice(line.as_bytes());
        } else {
            prefix.extend_from_slice(line.as_bytes());
        }
    }
    if let Some(hunk) = current {
        hunks.push(hunk);
    }
    if hunks.len() != read.document.hunks.len() {
        return Err(DiffError::GitFailed);
    }
    let mut patch = prefix;
    for index in selected {
        patch.extend_from_slice(&hunks[index]);
    }
    Ok(patch)
}

pub fn select_rows(read: &DiffRead, selected: &[(usize, usize)]) -> Result<Vec<u8>, DiffError> {
    if selected.is_empty() || read.document.status != DiffContentStatus::Text {
        return Err(DiffError::InvalidPath);
    }
    let requested_count = selected.len();
    let selected = selected
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    if selected.len() != requested_count {
        return Err(DiffError::InvalidPath);
    }
    let patch_lines = read
        .patch
        .split_inclusive(|byte| *byte == b'\n')
        .collect::<Vec<_>>();
    let first_hunk = patch_lines
        .iter()
        .position(|line| parse_hunk_header(String::from_utf8_lossy(line).trim_end()).is_some())
        .ok_or(DiffError::InvalidPath)?;
    let mut patch = patch_lines[..first_hunk]
        .iter()
        .flat_map(|line| line.iter().copied())
        .collect::<Vec<_>>();
    for (hunk_index, row_index) in selected {
        let row = read
            .document
            .hunks
            .get(hunk_index)
            .and_then(|hunk| hunk.rows.get(row_index))
            .filter(|row| row.kind == DiffRowKind::Change && !row.patch_change_lines.is_empty())
            .ok_or(DiffError::InvalidPath)?;
        let old_count = u32::from(row.old_text.is_some());
        let new_count = u32::from(row.new_text.is_some());
        let old_start = row
            .old_line
            .or(row.old_position)
            .ok_or(DiffError::InvalidPath)?;
        let new_start = row
            .new_line
            .or(row.new_position)
            .ok_or(DiffError::InvalidPath)?;
        patch.extend_from_slice(
            format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@\n").as_bytes(),
        );
        let mut change_lines = row.patch_change_lines.clone();
        change_lines.sort_unstable();
        for patch_line in change_lines {
            let line = patch_lines.get(patch_line).ok_or(DiffError::GitFailed)?;
            patch.extend_from_slice(line);
            if let Some(marker) = patch_lines.get(patch_line + 1) {
                if marker.starts_with(b"\\ No newline at end of file") {
                    patch.extend_from_slice(marker);
                }
            }
        }
    }
    Ok(patch)
}

pub fn select_changes(read: &DiffRead, selection: &[DiffSelection]) -> Result<Vec<u8>, DiffError> {
    if selection.is_empty() {
        return Err(DiffError::InvalidPath);
    }
    if selection.iter().all(|item| item.row_index.is_none()) {
        return select_hunks(
            read,
            &selection
                .iter()
                .map(|item| item.hunk_index)
                .collect::<Vec<_>>(),
        );
    }
    let mut rows = Vec::new();
    for item in selection {
        let hunk = read
            .document
            .hunks
            .get(item.hunk_index)
            .ok_or(DiffError::InvalidPath)?;
        if let Some(row_index) = item.row_index {
            rows.push((item.hunk_index, row_index));
        } else {
            rows.extend(
                hunk.rows
                    .iter()
                    .enumerate()
                    .filter(|(_, row)| row.kind == DiffRowKind::Change)
                    .map(|(row_index, _)| (item.hunk_index, row_index)),
            );
        }
    }
    select_rows(read, &rows)
}

fn classify_git_error(error: &str) -> DiffError {
    if error.contains("permission denied") || error.contains("access is denied") {
        DiffError::PermissionDenied
    } else if error.contains("could not access") || error.contains("no such file") {
        DiffError::PathNotFound
    } else {
        DiffError::GitFailed
    }
}

async fn read_capped<R: AsyncRead + Unpin>(
    mut stream: R,
    limit: usize,
) -> std::io::Result<CappedOutput> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut chunk = [0_u8; 8192];
    let mut overflowed = false;
    loop {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let available = limit.saturating_sub(bytes.len());
        let kept = available.min(count);
        bytes.extend_from_slice(&chunk[..kept]);
        overflowed |= kept != count;
    }
    Ok(CappedOutput { bytes, overflowed })
}

struct CappedOutput {
    bytes: Vec<u8>,
    overflowed: bool,
}

enum FilePathState {
    Regular,
    Missing,
    Symlink,
    Submodule,
}

async fn inspect_path(repository_path: &Path, relative: &str) -> Result<FilePathState, DiffError> {
    let path = Path::new(relative);
    let mut current = repository_path.to_path_buf();
    let components = path.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(component) = component else {
            return Err(DiffError::InvalidPath);
        };
        current.push(component);
        let metadata = match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if index + 1 == components.len() {
                    return Ok(FilePathState::Missing);
                }
                return Err(DiffError::PathNotFound);
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(DiffError::PermissionDenied);
            }
            Err(_) => return Err(DiffError::PathNotFound),
        };
        if metadata.file_type().is_symlink() {
            return Ok(FilePathState::Symlink);
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Err(DiffError::PathNotFound);
        }
        if index + 1 == components.len() && metadata.is_dir() {
            return Ok(FilePathState::Submodule);
        }
    }
    Ok(FilePathState::Regular)
}

fn validate_repo_relative_path(value: &str) -> Result<(), DiffError> {
    if value.is_empty()
        || value.chars().any(char::is_control)
        || has_windows_drive_prefix(value)
        || value.contains('\\')
        || Path::new(value).is_absolute()
        || !Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(DiffError::InvalidPath);
    }
    Ok(())
}

fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

struct ParsedDiff {
    binary: bool,
    hunks: Vec<DiffHunk>,
}

fn parse_diff(output: &[u8]) -> ParsedDiff {
    let text = String::from_utf8_lossy(output);
    let mut binary = false;
    let mut hunks = Vec::new();
    let mut current: Option<DiffHunk> = None;
    let mut old_line = 0_u32;
    let mut new_line = 0_u32;
    let mut changes = Vec::new();

    for (patch_line, line) in text.lines().enumerate() {
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            binary = true;
            continue;
        }
        if let Some((old_start, old_count, new_start, new_count)) = parse_hunk_header(line) {
            if let Some(mut hunk) = current.take() {
                flush_changes(&mut hunk.rows, &mut changes);
                hunks.push(hunk);
            }
            old_line = old_start;
            new_line = new_start;
            current = Some(DiffHunk {
                old_start,
                old_lines: old_count,
                new_start,
                new_lines: new_count,
                rows: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = current.as_mut() else {
            continue;
        };
        if let Some(text) = line.strip_prefix(' ') {
            flush_changes(&mut hunk.rows, &mut changes);
            hunk.rows.push(DiffRow {
                kind: DiffRowKind::Context,
                old_line: Some(old_line),
                new_line: Some(new_line),
                old_text: Some(text.to_owned()),
                new_text: Some(text.to_owned()),
                patch_change_lines: Vec::new(),
                old_position: Some(old_line),
                new_position: Some(new_line),
            });
            old_line += 1;
            new_line += 1;
        } else if let Some(text) = line.strip_prefix('-') {
            changes.push(RawLine::Deletion {
                text: text.to_owned(),
                line: old_line,
                old_position: old_line,
                new_position: new_line,
                patch_line,
            });
            old_line += 1;
        } else if let Some(text) = line.strip_prefix('+') {
            changes.push(RawLine::Addition {
                text: text.to_owned(),
                line: new_line,
                old_position: old_line,
                new_position: new_line,
                patch_line,
            });
            new_line += 1;
        }
    }
    if let Some(mut hunk) = current {
        flush_changes(&mut hunk.rows, &mut changes);
        hunks.push(hunk);
    }
    ParsedDiff { binary, hunks }
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let header = line.strip_prefix("@@ ")?.split_once(" @@")?.0;
    let (old, new) = header.split_once(' ')?;
    let (old_start, old_count) = parse_range(old.strip_prefix('-')?)?;
    let (new_start, new_count) = parse_range(new.strip_prefix('+')?)?;
    Some((old_start, old_count, new_start, new_count))
}

fn parse_range(value: &str) -> Option<(u32, u32)> {
    if let Some((start, count)) = value.split_once(',') {
        Some((start.parse().ok()?, count.parse().ok()?))
    } else {
        Some((value.parse().ok()?, 1))
    }
}

fn flush_changes(rows: &mut Vec<DiffRow>, changes: &mut Vec<RawLine>) {
    if changes.is_empty() {
        return;
    }
    let mut old = Vec::new();
    let mut new = Vec::new();
    for change in changes.drain(..) {
        match change {
            RawLine::Deletion {
                text,
                line,
                old_position,
                new_position,
                patch_line,
            } => old.push((text, line, old_position, new_position, patch_line)),
            RawLine::Addition {
                text,
                line,
                old_position,
                new_position,
                patch_line,
            } => new.push((text, line, old_position, new_position, patch_line)),
        }
    }
    for index in 0..old.len().max(new.len()) {
        let old_entry = old.get(index);
        let new_entry = new.get(index);
        let mut patch_change_lines = Vec::new();
        if let Some(entry) = old_entry {
            patch_change_lines.push(entry.4);
        }
        if let Some(entry) = new_entry {
            patch_change_lines.push(entry.4);
        }
        rows.push(DiffRow {
            kind: DiffRowKind::Change,
            old_line: old_entry.map(|(_, line, _, _, _)| *line),
            new_line: new_entry.map(|(_, line, _, _, _)| *line),
            old_text: old_entry.map(|(text, _, _, _, _)| text.clone()),
            new_text: new_entry.map(|(text, _, _, _, _)| text.clone()),
            patch_change_lines,
            old_position: old_entry
                .map(|(_, _, position, _, _)| *position)
                .or_else(|| new_entry.map(|(_, _, position, _, _)| *position)),
            new_position: new_entry
                .map(|(_, _, _, position, _)| *position)
                .or_else(|| old_entry.map(|(_, _, _, position, _)| *position)),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status;

    fn git(root: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    async fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        tokio::fs::create_dir(&root).await.unwrap();
        git(&root, &["init", "--quiet"]);
        git(&root, &["config", "user.name", "GitCrest Test"]);
        git(
            &root,
            &["config", "user.email", "gitcrest-test@example.invalid"],
        );
        tokio::fs::write(root.join("readme.txt"), "base line\nkept line\n")
            .await
            .unwrap();
        tokio::fs::write(root.join("rename-me.txt"), "rename fixture\n")
            .await
            .unwrap();
        tokio::fs::write(root.join("delete-me.txt"), "delete fixture\n")
            .await
            .unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "--quiet", "-m", "base"]);
        (directory, root)
    }

    #[test]
    fn parses_unified_hunks_into_aligned_split_rows() {
        let parsed = parse_diff(b"diff --git a/file.txt b/file.txt\nindex 123..456 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@ heading\n before\n-old one\n-old two\n+new one\n+new two\n after\n");
        assert!(!parsed.binary);
        let rows = &parsed.hunks[0].rows;
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].kind, DiffRowKind::Context);
        assert_eq!(rows[1].old_text.as_deref(), Some("old one"));
        assert_eq!(rows[1].new_text.as_deref(), Some("new one"));
        assert_eq!(rows[2].old_text.as_deref(), Some("old two"));
        assert_eq!(rows[2].new_text.as_deref(), Some("new two"));
        assert_eq!(rows[3].old_line, Some(4));
        assert_eq!(rows[3].new_line, Some(4));
    }

    #[test]
    fn rejects_paths_that_escape_the_repository() {
        assert!(validate_repo_relative_path("src/file.rs").is_ok());
        assert_eq!(
            validate_repo_relative_path("../secret"),
            Err(DiffError::InvalidPath)
        );
        assert_eq!(
            validate_repo_relative_path("C:/secret"),
            Err(DiffError::InvalidPath)
        );
        assert_eq!(
            validate_repo_relative_path(r"C:\secret"),
            Err(DiffError::InvalidPath)
        );
        assert_eq!(
            validate_repo_relative_path(r"\\server\share\secret"),
            Err(DiffError::InvalidPath)
        );
    }

    #[tokio::test]
    async fn reads_index_working_tree_untracked_binary_deleted_and_renamed_diffs() {
        let (_directory, root) = fixture().await;
        tokio::fs::write(root.join("readme.txt"), "staged line\nkept line\n")
            .await
            .unwrap();
        git(&root, &["add", "readme.txt"]);
        tokio::fs::write(root.join("readme.txt"), "working line\nkept line\n")
            .await
            .unwrap();
        git(&root, &["mv", "rename-me.txt", "renamed.txt"]);
        tokio::fs::remove_file(root.join("delete-me.txt"))
            .await
            .unwrap();
        tokio::fs::write(root.join("new file.txt"), "new file content\n")
            .await
            .unwrap();
        tokio::fs::write(root.join("binary.bin"), [0, 1, 2, 0, 255])
            .await
            .unwrap();
        let snapshot = status::read("repo-test".into(), &root).await.unwrap();
        let staged = snapshot.files.iter().find(|file| file.path == "readme.txt");
        let staged = staged.expect("staged path is reported");
        let index = read("repo-test".into(), &root, staged, DiffScope::Index)
            .await
            .unwrap();
        assert!(index
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.rows)
            .any(|row| row.new_text.as_deref() == Some("staged line")));
        let working = read("repo-test".into(), &root, staged, DiffScope::WorkingTree)
            .await
            .unwrap();
        assert!(working
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.rows)
            .any(|row| row.new_text.as_deref() == Some("working line")));

        let deleted = snapshot
            .files
            .iter()
            .find(|file| file.path == "delete-me.txt")
            .unwrap();
        let deleted_diff = read("repo-test".into(), &root, deleted, DiffScope::WorkingTree)
            .await
            .unwrap();
        assert!(deleted_diff
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.rows)
            .any(|row| row.old_text.as_deref() == Some("delete fixture")));

        let new_file = snapshot
            .files
            .iter()
            .find(|file| file.path == "new file.txt")
            .unwrap();
        let untracked = read("repo-test".into(), &root, new_file, DiffScope::WorkingTree)
            .await
            .unwrap();
        assert_eq!(untracked.status, DiffContentStatus::Text);
        assert!(untracked
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.rows)
            .any(|row| row.new_text.as_deref() == Some("new file content")));

        let binary_file = snapshot
            .files
            .iter()
            .find(|file| file.path == "binary.bin")
            .unwrap();
        let binary = read(
            "repo-test".into(),
            &root,
            binary_file,
            DiffScope::WorkingTree,
        )
        .await
        .unwrap();
        assert_eq!(binary.status, DiffContentStatus::Binary);

        let renamed = snapshot
            .files
            .iter()
            .find(|file| file.kind == ChangeKind::Renamed)
            .unwrap();
        let renamed_diff = read("repo-test".into(), &root, renamed, DiffScope::Index)
            .await
            .unwrap();
        assert_eq!(renamed_diff.change_kind, ChangeKind::Renamed);
        assert_eq!(renamed_diff.original_path.as_deref(), Some("rename-me.txt"));
    }

    #[tokio::test]
    async fn preserves_raw_git_patch_and_rejects_diffs_over_the_display_limit() {
        let (_directory, root) = fixture().await;
        tokio::fs::write(
            root.join("readme.txt"),
            "base line\nkept line\nchanged one\nchanged two\n",
        )
        .await
        .unwrap();
        let snapshot = status::read("repo-test".into(), &root).await.unwrap();
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == "readme.txt")
            .unwrap();
        let result = read_with_patch("repo-test".into(), &root, file, DiffScope::WorkingTree)
            .await
            .unwrap();
        let git_patch = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args([
                "--literal-pathspecs",
                "diff",
                "--no-ext-diff",
                "--no-color",
                "--unified=3",
                "--",
                "readme.txt",
            ])
            .output()
            .unwrap();
        assert!(git_patch.status.success());
        assert_eq!(result.patch, git_patch.stdout);
        assert_eq!(result.document.hunks, parse_diff(&git_patch.stdout).hunks);

        let large = "x".repeat(MAX_DIFF_BYTES + 1);
        tokio::fs::write(root.join("readme.txt"), large)
            .await
            .unwrap();
        let snapshot = status::read("repo-test".into(), &root).await.unwrap();
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == "readme.txt")
            .unwrap();
        assert_eq!(
            read("repo-test".into(), &root, file, DiffScope::WorkingTree).await,
            Err(DiffError::TooLarge)
        );
    }
}
