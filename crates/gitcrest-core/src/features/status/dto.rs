use serde::Serialize;

use crate::domain::status::{ChangeCategory, ChangeKind, StatusFile, StatusSnapshot};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StatusSnapshotDto {
    repo_id: String,
    refreshed_at_ms: i64,
    files: Vec<StatusFileDto>,
}

impl From<StatusSnapshot> for StatusSnapshotDto {
    fn from(snapshot: StatusSnapshot) -> Self {
        Self {
            repo_id: snapshot.repo_id,
            refreshed_at_ms: snapshot.refreshed_at_ms,
            files: snapshot.files.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusFileDto {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_path: Option<String>,
    index_status: String,
    worktree_status: String,
    kind: ChangeKindDto,
    categories: Vec<ChangeCategoryDto>,
    mode_changed: bool,
}

impl From<StatusFile> for StatusFileDto {
    fn from(file: StatusFile) -> Self {
        Self {
            path: file.path,
            original_path: file.original_path,
            index_status: file.index_status,
            worktree_status: file.worktree_status,
            kind: file.kind.into(),
            categories: file.categories.into_iter().map(Into::into).collect(),
            mode_changed: file.mode_changed,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum ChangeKindDto {
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

impl From<ChangeKind> for ChangeKindDto {
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
enum ChangeCategoryDto {
    Staged,
    Unstaged,
    Untracked,
    Ignored,
    Conflicted,
}

impl From<ChangeCategory> for ChangeCategoryDto {
    fn from(category: ChangeCategory) -> Self {
        match category {
            ChangeCategory::Staged => Self::Staged,
            ChangeCategory::Unstaged => Self::Unstaged,
            ChangeCategory::Untracked => Self::Untracked,
            ChangeCategory::Ignored => Self::Ignored,
            ChangeCategory::Conflicted => Self::Conflicted,
        }
    }
}
