use super::{
    evidence::{self, EvidenceError, PreservationSnapshot},
    operation_save::SaveGroup,
    preparation::{patch_storage_size, ShelfSelection},
    ShelfError, MAX_PATCH_BYTES,
};
use crate::{
    domain::{
        diff::{DiffContentStatus, DiffScope},
        status::ChangeKind,
    },
    features::diff::{self, DiffError},
    ports::{
        diff::{DiffGitPort, DiffWorktreePort},
        git::GitReadPort,
        status::StatusReadPort,
    },
};
use std::path::Path;

#[cfg(test)]
mod tests;

pub(crate) struct PreservationPlan {
    pub before: PreservationSnapshot,
    pub groups: Vec<SaveGroup>,
    pub patch_bytes: u64,
}
#[derive(Debug)]
pub(crate) struct PreservationBlocker {
    pub path: String,
    pub scope: DiffScope,
    pub reason: BlockerReason,
}
#[derive(Debug)]
pub(crate) enum BlockerReason {
    Unsupported(DiffContentStatus),
    UnsupportedPathRelation,
    PatchTooLarge,
    ReadFailed(DiffError),
}
#[derive(Debug)]
pub(crate) enum PlanningError {
    Unavailable,
    Metadata(ShelfError),
    Evidence(EvidenceError),
    Blocked(Vec<PreservationBlocker>),
    Changed,
}

/// Reviews every dirty scope without retaining raw patch bodies or performing
/// writes. The caller still decides whether preservation is needed for its
/// command, and execution must recheck this review after ownership is acquired.
pub(crate) async fn read_plan<G: GitReadPort + DiffGitPort + StatusReadPort>(
    git: &G,
    worktree: &dyn DiffWorktreePort,
    repo_id: &str,
    path: &Path,
    name: &str,
    description: &str,
) -> Result<PreservationPlan, PlanningError> {
    super::validate_metadata(name, description).map_err(PlanningError::Metadata)?;
    let mut status = git
        .read_status(repo_id.into(), path, &[])
        .await
        .map_err(|_| PlanningError::Unavailable)?;
    if status.files.len() > 1000 {
        return Err(PlanningError::Evidence(EvidenceError::Unsupported));
    }
    status
        .files
        .sort_by(|left, right| left.path.cmp(&right.path));
    let mut batches = Batches {
        name,
        description,
        groups: vec![],
        pending: vec![],
        bytes: 0,
    };
    let mut blockers = Vec::new();
    let mut patch_bytes = 0u64;
    for scope in [DiffScope::WorkingTree, DiffScope::Index] {
        for file in status
            .files
            .iter()
            .filter(|file| file.has_unignored_changes() && file.has_changes_for_scope(scope))
        {
            if file.original_path.is_some()
                || matches!(file.kind, ChangeKind::Renamed | ChangeKind::Copied)
            {
                blockers.push(PreservationBlocker {
                    path: file.path.clone(),
                    scope,
                    reason: BlockerReason::UnsupportedPathRelation,
                });
                continue;
            }
            let read = match diff::read_with_patch(git, worktree, repo_id.into(), path, file, scope)
                .await
            {
                Ok(read) => read,
                Err(DiffError::GitUnavailable | DiffError::TimedOut) => {
                    return Err(PlanningError::Unavailable)
                }
                Err(error) => {
                    blockers.push(PreservationBlocker {
                        path: file.path.clone(),
                        scope,
                        reason: if error == DiffError::TooLarge {
                            BlockerReason::PatchTooLarge
                        } else {
                            BlockerReason::ReadFailed(error)
                        },
                    });
                    continue;
                }
            };
            if read.document.status != DiffContentStatus::Text
                || read.document.hunks.is_empty()
                || std::str::from_utf8(&read.patch).is_err()
            {
                blockers.push(PreservationBlocker {
                    path: file.path.clone(),
                    scope,
                    reason: BlockerReason::Unsupported(read.document.status),
                });
                continue;
            }
            let size = match patch_storage_size(&read.patch) {
                Ok(size) => size,
                Err(_) => {
                    blockers.push(PreservationBlocker {
                        path: file.path.clone(),
                        scope,
                        reason: BlockerReason::PatchTooLarge,
                    });
                    continue;
                }
            };
            batches.push(
                ShelfSelection {
                    path: file.path.clone(),
                    scope,
                    revision: read.document.revision,
                    selections: vec![],
                },
                size,
            )?;
            patch_bytes += size as u64;
        }
        batches.flush();
    }
    if !blockers.is_empty() {
        return Err(PlanningError::Blocked(blockers));
    }
    let before = evidence::read_snapshot(git, worktree, repo_id, path)
        .await
        .map_err(PlanningError::Evidence)?;
    if !before.matches_changes(
        batches
            .groups
            .iter()
            .flat_map(|group| group.selections.iter())
            .map(|selection| {
                (
                    selection.path.as_str(),
                    selection.scope,
                    selection.revision.as_str(),
                )
            }),
    ) {
        return Err(PlanningError::Changed);
    }
    let count: u32 = batches
        .groups
        .len()
        .try_into()
        .map_err(|_| PlanningError::Unavailable)?;
    for (index, group) in batches.groups.iter_mut().enumerate() {
        group.save_order = index as u32;
        group.restore_order = count - 1 - group.save_order;
    }
    Ok(PreservationPlan {
        before,
        groups: batches.groups,
        patch_bytes,
    })
}

struct Batches<'a> {
    name: &'a str,
    description: &'a str,
    groups: Vec<SaveGroup>,
    pending: Vec<ShelfSelection>,
    bytes: usize,
}
impl Batches<'_> {
    fn push(&mut self, selection: ShelfSelection, size: usize) -> Result<(), PlanningError> {
        if size == 0 || size > MAX_PATCH_BYTES {
            return Err(PlanningError::Blocked(vec![PreservationBlocker {
                path: selection.path,
                scope: selection.scope,
                reason: BlockerReason::PatchTooLarge,
            }]));
        }
        if self.pending.len() == 100 || size > MAX_PATCH_BYTES - self.bytes {
            self.flush();
        }
        self.bytes += size;
        self.pending.push(selection);
        Ok(())
    }
    fn flush(&mut self) {
        if !self.pending.is_empty() {
            self.groups.push(SaveGroup {
                name: self.name.into(),
                description: self.description.into(),
                selections: std::mem::take(&mut self.pending),
                save_order: 0,
                restore_order: 0,
            });
        }
        self.bytes = 0;
    }
}
