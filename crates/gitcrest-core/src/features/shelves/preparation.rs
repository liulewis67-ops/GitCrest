use std::{collections::HashSet, path::Path};

use super::{validate_patch, ShelfError, MAX_PATCH_BYTES};
use crate::{
    domain::{
        diff::{DiffContentStatus, DiffScope, DiffSelection},
        status::StatusFile,
    },
    features::diff::{self, DiffError},
    ports::diff::{DiffGitPort, DiffWorktreePort},
};

/// Application input, independent of HTTP selection DTOs and task submission.
pub(crate) struct ShelfSelection {
    pub path: String,
    pub scope: DiffScope,
    pub revision: String,
    pub selections: Vec<DiffSelection>,
}

#[derive(Clone)]
pub(crate) struct PreparedShelfItem {
    pub path: String,
    pub scope: DiffScope,
    pub patch: Vec<u8>,
}

pub(crate) struct PreparedShelf {
    pub items: Vec<PreparedShelfItem>,
    pub patch: Vec<u8>,
    pub paths: Vec<String>,
    pub scope: DiffScope,
}

pub(crate) enum PreparationError {
    Shelf(ShelfError),
    Diff(DiffError),
    StaleSelection,
}

/// Reads and validates patches only. The caller must repeat this under its
/// execution permit before persisting a backup or removing local changes.
pub(crate) async fn prepare_items(
    git: &impl DiffGitPort,
    worktree: &dyn DiffWorktreePort,
    repo_id: &str,
    repository_path: &Path,
    files: &[StatusFile],
    items: &[ShelfSelection],
) -> Result<PreparedShelf, PreparationError> {
    if items.is_empty() || items.len() > 100 {
        return Err(PreparationError::Shelf(ShelfError::EmptySelection));
    }
    let scope = items[0].scope;
    if items.iter().any(|item| item.scope != scope) {
        return Err(PreparationError::Shelf(ShelfError::MixedScopes));
    }
    let mut paths = HashSet::new();
    let mut prepared = Vec::with_capacity(items.len());
    for item in items {
        let scope = item.scope;
        if scope == DiffScope::Commit || !paths.insert(item.path.as_str()) {
            return Err(PreparationError::Shelf(ShelfError::EmptySelection));
        }
        let file = files
            .iter()
            .find(|file| file.path == item.path)
            .ok_or(PreparationError::StaleSelection)?;
        let current = diff::read_with_patch(
            git,
            worktree,
            repo_id.to_owned(),
            repository_path,
            file,
            scope,
        )
        .await
        .map_err(PreparationError::Diff)?;
        if current.document.revision != item.revision {
            return Err(PreparationError::StaleSelection);
        }
        if current.document.status != DiffContentStatus::Text {
            return Err(PreparationError::Shelf(ShelfError::EmptySelection));
        }
        let patch = if item.selections.is_empty() {
            current.patch
        } else {
            diff::select_changes(&current, &item.selections).map_err(|error| {
                if error == DiffError::InvalidPath {
                    PreparationError::Shelf(ShelfError::EmptySelection)
                } else {
                    PreparationError::Diff(error)
                }
            })?
        };
        validate_patch(&patch, std::slice::from_ref(&item.path))
            .map_err(PreparationError::Shelf)?;
        if std::str::from_utf8(&patch).is_err() {
            return Err(PreparationError::Shelf(ShelfError::EmptySelection));
        }
        prepared.push(PreparedShelfItem {
            path: item.path.clone(),
            scope,
            patch,
        });
    }
    assemble(prepared, scope).map_err(PreparationError::Shelf)
}

fn assemble(items: Vec<PreparedShelfItem>, scope: DiffScope) -> Result<PreparedShelf, ShelfError> {
    let mut patch = Vec::new();
    let mut paths = Vec::with_capacity(items.len());
    for item in &items {
        let size = patch_storage_size(&item.patch)?;
        if size > MAX_PATCH_BYTES.saturating_sub(patch.len()) {
            return Err(ShelfError::PatchTooLarge);
        }
        patch.extend_from_slice(&item.patch);
        if item.patch.last() != Some(&b'\n') {
            patch.push(b'\n');
        }
        paths.push(item.path.clone());
    }
    paths.sort();
    paths.dedup();
    validate_patch(&patch, &paths)?;
    Ok(PreparedShelf {
        items,
        patch,
        paths,
        scope,
    })
}

pub(super) fn patch_storage_size(patch: &[u8]) -> Result<usize, ShelfError> {
    if patch.is_empty() {
        return Err(ShelfError::EmptySelection);
    }
    patch
        .len()
        .checked_add(usize::from(patch.last() != Some(&b'\n')))
        .filter(|size| *size <= MAX_PATCH_BYTES)
        .ok_or(ShelfError::PatchTooLarge)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shelf_batch_limit_includes_the_required_patch_separator() {
        let item = PreparedShelfItem {
            path: "file.txt".into(),
            scope: DiffScope::Index,
            patch: vec![b'x'; MAX_PATCH_BYTES],
        };
        assert!(matches!(
            assemble(vec![item.clone()], DiffScope::Index),
            Err(ShelfError::PatchTooLarge)
        ));
        let mut bounded = item;
        *bounded.patch.last_mut().unwrap() = b'\n';
        let result = assemble(vec![bounded], DiffScope::Index).ok().unwrap();
        assert_eq!(result.patch.len(), MAX_PATCH_BYTES);
    }

    #[test]
    fn shelf_batch_bounds_the_sum_and_keeps_patch_order_independent_of_path_sorting() {
        let item = |path: &str, patch: Vec<u8>| PreparedShelfItem {
            path: path.into(),
            scope: DiffScope::WorkingTree,
            patch,
        };
        assert!(matches!(
            assemble(
                vec![
                    item("z", vec![b'x'; MAX_PATCH_BYTES / 2]),
                    item("a", vec![b'x'; MAX_PATCH_BYTES / 2]),
                ],
                DiffScope::WorkingTree
            ),
            Err(ShelfError::PatchTooLarge)
        ));
        let result = assemble(
            vec![item("z", b"z".to_vec()), item("a", b"a\n".to_vec())],
            DiffScope::WorkingTree,
        )
        .ok()
        .unwrap();
        assert_eq!(result.patch, b"z\na\n");
        assert_eq!(result.paths, ["a", "z"]);
    }
}
