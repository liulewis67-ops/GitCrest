use super::{diff::DiffScope, status::StatusFile};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShelfSnapshot {
    pub shelf_id: String,
    pub repo_id: String,
    pub name: String,
    pub description: String,
    pub paths: Vec<String>,
    pub scope: Option<DiffScope>,
    pub head_oid: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShelfRecord {
    pub snapshot: ShelfSnapshot,
    pub patch: Vec<u8>,
}

impl ShelfSnapshot {
    pub(crate) fn supports_three_way_apply(&self, has_head: bool) -> bool {
        has_head && matches!(self.scope, Some(DiffScope::WorkingTree | DiffScope::Index))
    }

    pub(crate) fn can_apply_with_conflicts(
        &self,
        repository_is_normal: bool,
        has_head: bool,
        status_files: &[StatusFile],
    ) -> bool {
        if !self.supports_three_way_apply(has_head) || !repository_is_normal {
            return false;
        }
        let Some(scope) = self.scope else {
            return false;
        };
        if status_files.iter().any(StatusFile::is_conflicted) {
            return false;
        }
        self.paths.iter().all(|path| {
            status_files
                .iter()
                .find(|file| file.path == *path)
                .is_none_or(|file| match scope {
                    // The merge uses the current index as OURS and restores it
                    // afterwards, preserving an already-restored staged shelf.
                    DiffScope::WorkingTree => !file.has_changes_for_scope(DiffScope::WorkingTree),
                    DiffScope::Index => !file.has_changes_for_scope(DiffScope::WorkingTree),
                    DiffScope::Commit => false,
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::status::{ChangeCategory, ChangeKind};

    fn shelf(scope: Option<DiffScope>, paths: &[&str]) -> ShelfSnapshot {
        ShelfSnapshot {
            shelf_id: "shelf-1".into(),
            repo_id: "repo-1".into(),
            name: "reviewed changes".into(),
            description: String::new(),
            paths: paths.iter().map(|path| (*path).into()).collect(),
            scope,
            head_oid: Some("abc123".into()),
            created_at_ms: 1,
        }
    }

    fn status(path: &str, categories: Vec<ChangeCategory>, kind: ChangeKind) -> StatusFile {
        StatusFile {
            path: path.into(),
            original_path: None,
            index_status: String::new(),
            worktree_status: String::new(),
            kind,
            categories,
            mode_changed: false,
        }
    }

    #[test]
    fn allows_three_way_apply_when_selected_paths_do_not_overlap_other_scope() {
        let staged = status(
            "file.txt",
            vec![ChangeCategory::Staged],
            ChangeKind::Modified,
        );

        assert!(
            shelf(Some(DiffScope::WorkingTree), &["file.txt"]).can_apply_with_conflicts(
                true,
                true,
                std::slice::from_ref(&staged)
            )
        );
        assert!(
            shelf(Some(DiffScope::Index), &["file.txt"]).can_apply_with_conflicts(
                true,
                true,
                std::slice::from_ref(&staged)
            )
        );
    }

    #[test]
    fn rejects_three_way_apply_for_conflicts_scope_overlap_or_unavailable_state() {
        let unstaged = status(
            "file.txt",
            vec![ChangeCategory::Unstaged],
            ChangeKind::Modified,
        );
        let conflict = status(
            "other.txt",
            vec![ChangeCategory::Conflicted],
            ChangeKind::Conflicted,
        );

        assert!(
            !shelf(Some(DiffScope::WorkingTree), &["file.txt"]).can_apply_with_conflicts(
                true,
                true,
                std::slice::from_ref(&unstaged)
            )
        );
        assert!(
            !shelf(Some(DiffScope::Index), &["file.txt"]).can_apply_with_conflicts(
                true,
                true,
                &[unstaged]
            )
        );
        assert!(
            !shelf(Some(DiffScope::Index), &["file.txt"]).can_apply_with_conflicts(
                true,
                true,
                &[conflict]
            )
        );
        assert!(
            !shelf(Some(DiffScope::Index), &["file.txt"]).can_apply_with_conflicts(
                false,
                true,
                &[]
            )
        );
        assert!(
            !shelf(Some(DiffScope::Index), &["file.txt"]).can_apply_with_conflicts(
                true,
                false,
                &[]
            )
        );
        assert!(
            !shelf(Some(DiffScope::Commit), &["file.txt"]).can_apply_with_conflicts(
                true,
                true,
                &[]
            )
        );
        assert!(!shelf(None, &["file.txt"]).can_apply_with_conflicts(true, true, &[]));
    }
}
