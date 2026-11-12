use crate::{
    domain::{
        diff::{DiffContentStatus, DiffScope, DiffWorktreeEntryKind},
        shelf::ShelfRecord,
        status::ChangeCategory,
        workflow::WorkflowOperation,
    },
    features::diff,
    ports::{
        diff::{DiffGitPort, DiffWorktreePort},
        git::GitReadPort,
        status::StatusReadPort,
    },
};
use sha2::{Digest, Sha256};
#[cfg(test)]
pub(crate) mod tests;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreservationSnapshot {
    head: Option<String>,
    branch: Option<String>,
    changes: BTreeMap<(String, String), String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EvidenceError {
    Unavailable,
    Unsupported,
    Changed,
}

impl PreservationSnapshot {
    pub fn is_clean(&self) -> bool {
        self.changes.is_empty()
    }
    pub fn has_staged_changes(&self) -> bool {
        self.changes.keys().any(|(_, scope)| scope == "index")
    }
    pub fn has_worktree_changes(&self) -> bool {
        self.changes.keys().any(|(_, scope)| scope == "workingTree")
    }
    pub fn worktree_fingerprint(&self) -> String {
        let entries = self
            .changes
            .iter()
            .filter(|((_, scope), _)| scope == "workingTree")
            .collect::<Vec<_>>();
        let bytes = serde_json::to_vec(&entries).expect("worktree evidence serializes");
        format!("{:x}", Sha256::digest(bytes))
    }
    pub fn matches_changes<'a>(
        &self,
        changes: impl Iterator<Item = (&'a str, DiffScope, &'a str)>,
    ) -> bool {
        let mut expected = BTreeMap::new();
        for (path, scope, revision) in changes {
            let name = match scope {
                DiffScope::Index => "index",
                DiffScope::WorkingTree => "workingTree",
                DiffScope::Commit => return false,
            };
            if expected
                .insert((path.into(), name.into()), revision.into())
                .is_some()
            {
                return false;
            }
        }
        expected == self.changes
    }
    pub fn matches_source(&self, head: Option<&str>, branch: Option<&str>) -> bool {
        self.head.as_deref() == head && self.branch.as_deref() == branch
    }
    pub fn fingerprint(&self) -> String {
        self.fingerprint_at(self.head.as_deref(), self.branch.as_deref())
    }
    pub fn fingerprint_at(&self, head: Option<&str>, branch: Option<&str>) -> String {
        let entries = self.changes.iter().collect::<Vec<_>>();
        let bytes =
            serde_json::to_vec(&(head, branch, entries)).expect("snapshot evidence serializes");
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    pub fn confirms_cleanup(&self, after: &Self, shelf: &ShelfRecord) -> bool {
        self.expected_cleanup(shelf).as_ref() == Some(after)
    }

    /// A known successful restore may affect only the selected scopes/paths.
    /// This checks observable collateral changes, not an atomic filesystem lease.
    pub fn confines_restore(&self, after: &Self, shelf: &ShelfRecord) -> bool {
        if self.head != after.head || self.branch != after.branch {
            return false;
        }
        let Some(scope) = shelf.snapshot.scope else {
            return false;
        };
        let selected = |key: &(String, String)| {
            shelf.snapshot.paths.contains(&key.0)
                && (key.1 == "workingTree" || scope == DiffScope::Index && key.1 == "index")
        };
        if scope == DiffScope::Commit {
            return false;
        }
        let before_other = self
            .changes
            .iter()
            .filter(|(key, _)| !selected(key))
            .collect::<BTreeMap<_, _>>();
        let after_other = after
            .changes
            .iter()
            .filter(|(key, _)| !selected(key))
            .collect::<BTreeMap<_, _>>();
        before_other == after_other
            && (scope != DiffScope::Index
                || !after
                    .changes
                    .keys()
                    .any(|key| key.1 == "workingTree" && shelf.snapshot.paths.contains(&key.0)))
    }

    pub fn expected_cleanup_fingerprint(&self, shelf: &ShelfRecord) -> Option<String> {
        self.expected_cleanup(shelf)
            .map(|expected| expected.fingerprint())
    }

    fn expected_cleanup(&self, shelf: &ShelfRecord) -> Option<Self> {
        if shelf.snapshot.head_oid != self.head || shelf.snapshot.paths.is_empty() {
            return None;
        }
        let scope = match shelf.snapshot.scope {
            Some(DiffScope::WorkingTree) => "workingTree",
            Some(DiffScope::Index) => "index",
            _ => return None,
        };
        let mut expected = self.changes.clone();
        for path in &shelf.snapshot.paths {
            expected.remove(&(path.clone(), scope.into()))?;
            if scope == "index" {
                expected.remove(&(path.clone(), "workingTree".into()));
            }
        }
        Some(Self {
            head: self.head.clone(),
            branch: self.branch.clone(),
            changes: expected,
        })
    }
}

/// Captures supported changes reported by Git twice. This detects observable
/// instability, not an atomic filesystem snapshot against external programs.
pub(crate) async fn read_snapshot<G: GitReadPort + DiffGitPort + StatusReadPort>(
    git: &G,
    worktree: &dyn DiffWorktreePort,
    repo_id: &str,
    path: &Path,
) -> Result<PreservationSnapshot, EvidenceError> {
    read_consistent(git, worktree, repo_id, path, false, None).await
}

pub(crate) async fn read_carry_snapshot<G: GitReadPort + DiffGitPort + StatusReadPort>(
    git: &G,
    worktree: &dyn DiffWorktreePort,
    repo_id: &str,
    path: &Path,
) -> Result<PreservationSnapshot, EvidenceError> {
    read_consistent(git, worktree, repo_id, path, true, None).await
}

pub(crate) async fn read_merge_resolution_snapshot<
    G: GitReadPort + DiffGitPort + StatusReadPort,
>(
    git: &G,
    worktree: &dyn DiffWorktreePort,
    repo_id: &str,
    path: &Path,
) -> Result<PreservationSnapshot, EvidenceError> {
    read_consistent(
        git,
        worktree,
        repo_id,
        path,
        true,
        Some(WorkflowOperation::Merge),
    )
    .await
}

async fn read_consistent<G: GitReadPort + DiffGitPort + StatusReadPort>(
    git: &G,
    worktree: &dyn DiffWorktreePort,
    repo_id: &str,
    path: &Path,
    carry: bool,
    operation: Option<WorkflowOperation>,
) -> Result<PreservationSnapshot, EvidenceError> {
    let first = capture(git, worktree, repo_id, path, carry, operation).await?;
    let second = capture(git, worktree, repo_id, path, carry, operation).await?;
    if first != second {
        return Err(EvidenceError::Changed);
    }
    Ok(second)
}

async fn capture<G: GitReadPort + DiffGitPort + StatusReadPort>(
    git: &G,
    worktree: &dyn DiffWorktreePort,
    repo_id: &str,
    path: &Path,
    carry: bool,
    operation: Option<WorkflowOperation>,
) -> Result<PreservationSnapshot, EvidenceError> {
    let head = git
        .read_head_oid(path)
        .await
        .map_err(|_| EvidenceError::Unavailable)?;
    let branch = git
        .read_current_branch(path)
        .await
        .map_err(|_| EvidenceError::Unavailable)?;
    let state = git
        .read_worktree_state(path)
        .await
        .map_err(|_| EvidenceError::Unavailable)?;
    if state.operation != operation
        || !state.conflicted_paths.is_empty()
        || state.omitted_conflicted_path_count > 0
        || state.omitted_dirty_path_count > 0
    {
        return Err(EvidenceError::Unsupported);
    }
    let status = git
        .read_status(repo_id.to_owned(), path, &[])
        .await
        .map_err(|_| EvidenceError::Unavailable)?;
    if status.files.len() > 1000 {
        return Err(EvidenceError::Unsupported);
    }
    let paths = status
        .files
        .iter()
        .filter(|file| file.has_unignored_changes())
        .map(|file| file.path.clone())
        .collect::<BTreeSet<_>>();
    if paths != state.dirty_paths.into_iter().collect() {
        return Err(EvidenceError::Changed);
    }
    let mut changes = BTreeMap::new();
    for file in status
        .files
        .iter()
        .filter(|file| file.has_unignored_changes())
    {
        if file.is_conflicted() {
            return Err(EvidenceError::Unsupported);
        }
        for (scope, name) in [
            (DiffScope::Index, "index"),
            (DiffScope::WorkingTree, "workingTree"),
        ] {
            if !file.has_changes_for_scope(scope) {
                continue;
            }
            if carry {
                let entry = worktree
                    .inspect_entry(path, &file.path)
                    .await
                    .map_err(|_| EvidenceError::Unavailable)?;
                if entry == DiffWorktreeEntryKind::Directory {
                    return Err(EvidenceError::Unsupported);
                }
                let untracked = scope == DiffScope::WorkingTree
                    && file.categories.contains(&ChangeCategory::Untracked);
                let patch = git
                    .read_checkout_patch(path, &file.path, scope, untracked)
                    .await
                    .map_err(|_| EvidenceError::Unavailable)?;
                if patch.is_empty() {
                    return Err(EvidenceError::Unsupported);
                }
                let mut hash = Sha256::new();
                hash.update(Sha256::digest(patch));
                if let Some(original) = file.original_path.as_deref() {
                    let original_patch = git
                        .read_checkout_patch(path, original, scope, false)
                        .await
                        .map_err(|_| EvidenceError::Unavailable)?;
                    hash.update(Sha256::digest(original_patch));
                    hash.update(original.as_bytes());
                }
                changes.insert(
                    (file.path.clone(), name.into()),
                    format!("sha256:{:x}", hash.finalize()),
                );
                continue;
            }
            let read = diff::read_with_patch(git, worktree, repo_id.to_owned(), path, file, scope)
                .await
                .map_err(|_| EvidenceError::Unavailable)?;
            if !matches!(
                read.document.status,
                DiffContentStatus::Text | DiffContentStatus::Empty
            ) {
                return Err(EvidenceError::Unsupported);
            }
            changes.insert((file.path.clone(), name.into()), read.document.revision);
        }
    }
    Ok(PreservationSnapshot {
        head,
        branch,
        changes,
    })
}
