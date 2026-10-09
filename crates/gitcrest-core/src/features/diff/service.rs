use std::time::Duration;

use serde::{Deserialize, Serialize};

mod read;
use read::parse_hunk_header;
#[cfg(test)]
use read::{parse_diff, validate_repo_relative_path};
pub use read::{read, read_commit_file, read_with_patch};
#[cfg(test)]
use std::path::Path;

use crate::features::status::{ChangeCategory, ChangeKind, StatusFile};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffContentStatus {
    Text,
    Binary,
    Empty,
    Conflicted,
    Ignored,
    Symlink,
    Submodule,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffRowKind {
    Context,
    Change,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffRow {
    pub kind: DiffRowKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    patch_change_lines: Vec<usize>,
    old_position: Option<u32>,
    new_position: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
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

#[derive(Clone, Debug, PartialEq, Eq)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::status;

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
