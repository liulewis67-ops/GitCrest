use serde::{Deserialize, Serialize};

use crate::domain::{
    diff::{
        DiffContentStatus, DiffContext, DiffDocument, DiffHunk, DiffRow, DiffRowKind, DiffScope,
    },
    status::ChangeKind,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiffDocumentDto {
    repo_id: String,
    path: String,
    revision: String,
    original_path: Option<String>,
    scope: DiffScopeDto,
    change_kind: DiffChangeKindDto,
    status: DiffContentStatusDto,
    hunks: Vec<DiffHunkDto>,
}

impl From<DiffDocument> for DiffDocumentDto {
    fn from(document: DiffDocument) -> Self {
        Self {
            repo_id: document.repo_id,
            path: document.path,
            revision: document.revision,
            original_path: document.original_path,
            scope: document.scope.into(),
            change_kind: document.change_kind.into(),
            status: document.status.into(),
            hunks: document.hunks.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DiffScopeDto {
    WorkingTree,
    Index,
    Commit,
}

impl From<DiffScope> for DiffScopeDto {
    fn from(scope: DiffScope) -> Self {
        match scope {
            DiffScope::WorkingTree => Self::WorkingTree,
            DiffScope::Index => Self::Index,
            DiffScope::Commit => Self::Commit,
        }
    }
}

impl From<DiffScopeDto> for DiffScope {
    fn from(scope: DiffScopeDto) -> Self {
        match scope {
            DiffScopeDto::WorkingTree => Self::WorkingTree,
            DiffScopeDto::Index => Self::Index,
            DiffScopeDto::Commit => Self::Commit,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum DiffChangeKindDto {
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

impl From<ChangeKind> for DiffChangeKindDto {
    fn from(kind: ChangeKind) -> Self {
        match kind {
            ChangeKind::Modified => Self::Modified,
            ChangeKind::Added => Self::Added,
            ChangeKind::Deleted => Self::Deleted,
            ChangeKind::Renamed => Self::Renamed,
            ChangeKind::Copied => Self::Copied,
            ChangeKind::TypeChanged => Self::TypeChanged,
            ChangeKind::Untracked => Self::Untracked,
            ChangeKind::Ignored => Self::Ignored,
            ChangeKind::Conflicted => Self::Conflicted,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum DiffContentStatusDto {
    Text,
    Binary,
    Empty,
    Conflicted,
    Ignored,
    Symlink,
    Submodule,
}

impl From<DiffContentStatus> for DiffContentStatusDto {
    fn from(status: DiffContentStatus) -> Self {
        match status {
            DiffContentStatus::Text => Self::Text,
            DiffContentStatus::Binary => Self::Binary,
            DiffContentStatus::Empty => Self::Empty,
            DiffContentStatus::Conflicted => Self::Conflicted,
            DiffContentStatus::Ignored => Self::Ignored,
            DiffContentStatus::Symlink => Self::Symlink,
            DiffContentStatus::Submodule => Self::Submodule,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffHunkDto {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    rows: Vec<DiffRowDto>,
}

impl From<DiffHunk> for DiffHunkDto {
    fn from(hunk: DiffHunk) -> Self {
        Self {
            old_start: hunk.old_start,
            old_lines: hunk.old_lines,
            new_start: hunk.new_start,
            new_lines: hunk.new_lines,
            rows: hunk.rows.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum DiffRowKindDto {
    Context,
    Change,
}

impl From<DiffRowKind> for DiffRowKindDto {
    fn from(kind: DiffRowKind) -> Self {
        match kind {
            DiffRowKind::Context => Self::Context,
            DiffRowKind::Change => Self::Change,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffRowDto {
    kind: DiffRowKindDto,
    old_line: Option<u32>,
    new_line: Option<u32>,
    old_text: Option<String>,
    new_text: Option<String>,
}

impl From<DiffRow> for DiffRowDto {
    fn from(row: DiffRow) -> Self {
        Self {
            kind: row.kind.into(),
            old_line: row.old_line,
            new_line: row.new_line,
            old_text: row.old_text,
            new_text: row.new_text,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiffQuery {
    pub(super) path: String,
    pub(super) scope: DiffScopeDto,
    #[serde(default)]
    pub(super) context: DiffContextDto,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CommitDiffQuery {
    pub(super) path: String,
    #[serde(default)]
    pub(super) context: DiffContextDto,
}

/// One file of a comparison. `from` and `to` are the full object ids the comparison returned;
/// leaving `to` out compares with the working tree.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RangeDiffQuery {
    pub(super) from: String,
    pub(super) to: Option<String>,
    pub(super) path: String,
    #[serde(default)]
    pub(super) context: DiffContextDto,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DiffContextDto {
    #[default]
    Hunks,
    Full,
}

impl From<DiffContextDto> for DiffContext {
    fn from(context: DiffContextDto) -> Self {
        match context {
            DiffContextDto::Hunks => Self::Hunks,
            DiffContextDto::Full => Self::FullFile,
        }
    }
}
