use std::path::{Component, Path};

use sha2::{Digest, Sha256};

use super::*;
use crate::{
    domain::diff::DiffWorktreeEntryKind,
    ports::diff::{DiffGitPort, DiffWorktreePort},
};

pub async fn read<G: DiffGitPort + ?Sized, W: DiffWorktreePort + ?Sized>(
    git: &G,
    worktree: &W,
    repo_id: String,
    repository_path: &Path,
    file: &StatusFile,
    scope: DiffScope,
) -> Result<DiffDocument, DiffError> {
    read_with_patch(git, worktree, repo_id, repository_path, file, scope)
        .await
        .map(|result| result.document)
}

pub async fn read_commit_file<G: DiffGitPort + ?Sized>(
    git: &G,
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
    let patch = git
        .read_commit_file_patch(repository_path, oid, parent_oid, relative_path)
        .await?;
    let parsed = parse_diff(&patch);
    let mut document = DiffDocument {
        repo_id,
        path: relative_path.to_owned(),
        revision: revision_for(DiffScope::Commit, relative_path, &patch),
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

pub async fn read_with_patch<G: DiffGitPort + ?Sized, W: DiffWorktreePort + ?Sized>(
    git: &G,
    worktree: &W,
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

    if file.is_conflicted() {
        document.status = DiffContentStatus::Conflicted;
        return Ok(DiffRead {
            document,
            patch: Vec::new(),
        });
    }
    if file.is_ignored() {
        document.status = DiffContentStatus::Ignored;
        return Ok(DiffRead {
            document,
            patch: Vec::new(),
        });
    }
    if scope != DiffScope::Commit && !file.has_changes_for_scope(scope) {
        return Ok(DiffRead {
            document,
            patch: Vec::new(),
        });
    }

    let file_path = worktree.inspect_entry(repository_path, &file.path).await?;
    match file_path {
        DiffWorktreeEntryKind::Symlink => {
            document.status = DiffContentStatus::Symlink;
            return Ok(DiffRead {
                document,
                patch: Vec::new(),
            });
        }
        DiffWorktreeEntryKind::Directory => {
            document.status = DiffContentStatus::Submodule;
            return Ok(DiffRead {
                document,
                patch: Vec::new(),
            });
        }
        DiffWorktreeEntryKind::Regular | DiffWorktreeEntryKind::Missing => {}
    }

    let untracked =
        scope == DiffScope::WorkingTree && file.categories.contains(&ChangeCategory::Untracked);
    let patch = git
        .read_file_patch(repository_path, &file.path, scope, untracked)
        .await?;
    document.revision = revision_for(scope, &file.path, &patch);
    let parsed = parse_diff(&patch);
    document.status = if parsed.binary {
        DiffContentStatus::Binary
    } else if parsed.hunks.is_empty() {
        DiffContentStatus::Empty
    } else {
        DiffContentStatus::Text
    };
    document.hunks = parsed.hunks;
    Ok(DiffRead { document, patch })
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

pub(super) fn validate_repo_relative_path(value: &str) -> Result<(), DiffError> {
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

pub(super) struct ParsedDiff {
    pub(super) binary: bool,
    pub(super) hunks: Vec<DiffHunk>,
}

pub(super) fn parse_diff(output: &[u8]) -> ParsedDiff {
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

pub(super) fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
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
