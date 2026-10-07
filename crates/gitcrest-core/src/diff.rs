use std::{
    path::{Component, Path},
    process::Stdio,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::status::{ChangeCategory, ChangeKind, StatusFile};

const MAX_DIFF_BYTES: usize = 10 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 16 * 1024;
const DIFF_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope {
    WorkingTree,
    Index,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffDocument {
    pub repo_id: String,
    pub path: String,
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

#[derive(Debug)]
enum RawLine {
    Addition(String, u32),
    Deletion(String, u32),
}

pub async fn read(
    repo_id: String,
    repository_path: &Path,
    file: &StatusFile,
    scope: DiffScope,
) -> Result<DiffDocument, DiffError> {
    validate_repo_relative_path(&file.path)?;
    let mut document = DiffDocument {
        repo_id,
        path: file.path.clone(),
        original_path: file.original_path.clone(),
        scope,
        change_kind: file.kind.clone(),
        status: DiffContentStatus::Empty,
        hunks: Vec::new(),
    };

    if file.categories.contains(&ChangeCategory::Conflicted) {
        document.status = DiffContentStatus::Conflicted;
        return Ok(document);
    }
    if file.categories.contains(&ChangeCategory::Ignored) {
        document.status = DiffContentStatus::Ignored;
        return Ok(document);
    }
    if scope == DiffScope::Index && !file.categories.contains(&ChangeCategory::Staged) {
        return Ok(document);
    }
    if scope == DiffScope::WorkingTree
        && !file.categories.iter().any(|category| {
            matches!(
                category,
                ChangeCategory::Unstaged | ChangeCategory::Untracked
            )
        })
    {
        return Ok(document);
    }

    let file_path = inspect_path(repository_path, &file.path).await?;
    match file_path {
        FilePathState::Symlink => {
            document.status = DiffContentStatus::Symlink;
            return Ok(document);
        }
        FilePathState::Submodule => {
            document.status = DiffContentStatus::Submodule;
            return Ok(document);
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
    let parsed = parse_diff(&stdout.bytes);
    document.status = if parsed.binary {
        DiffContentStatus::Binary
    } else if parsed.hunks.is_empty() {
        DiffContentStatus::Empty
    } else {
        DiffContentStatus::Text
    };
    document.hunks = parsed.hunks;
    Ok(document)
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
        || Path::new(value).is_absolute()
        || !Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(DiffError::InvalidPath);
    }
    Ok(())
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

    for line in text.lines() {
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
        if line.starts_with(' ') {
            flush_changes(&mut hunk.rows, &mut changes);
            hunk.rows.push(DiffRow {
                kind: DiffRowKind::Context,
                old_line: Some(old_line),
                new_line: Some(new_line),
                old_text: Some(line[1..].to_owned()),
                new_text: Some(line[1..].to_owned()),
            });
            old_line += 1;
            new_line += 1;
        } else if let Some(text) = line.strip_prefix('-') {
            changes.push(RawLine::Deletion(text.to_owned(), old_line));
            old_line += 1;
        } else if let Some(text) = line.strip_prefix('+') {
            changes.push(RawLine::Addition(text.to_owned(), new_line));
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
            RawLine::Deletion(text, line) => old.push((text, line)),
            RawLine::Addition(text, line) => new.push((text, line)),
        }
    }
    for index in 0..old.len().max(new.len()) {
        let old_entry = old.get(index);
        let new_entry = new.get(index);
        rows.push(DiffRow {
            kind: DiffRowKind::Change,
            old_line: old_entry.map(|(_, line)| *line),
            new_line: new_entry.map(|(_, line)| *line),
            old_text: old_entry.map(|(text, _)| text.clone()),
            new_text: new_entry.map(|(text, _)| text.clone()),
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
}
