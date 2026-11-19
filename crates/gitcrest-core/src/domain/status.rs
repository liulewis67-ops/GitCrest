use super::diff::DiffScope;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ChangeKind {
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ChangeCategory {
    Staged,
    Unstaged,
    Untracked,
    Ignored,
    Conflicted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusSnapshot {
    pub repo_id: String,
    pub refreshed_at_ms: i64,
    pub files: Vec<StatusFile>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusFile {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub kind: ChangeKind,
    pub categories: Vec<ChangeCategory>,
    pub mode_changed: bool,
}

pub(crate) fn overlapping_worktree_paths(
    files: &[StatusFile],
    saved_paths: &[String],
) -> Vec<String> {
    files
        .iter()
        .filter(|file| file.has_changes_for_scope(DiffScope::WorkingTree))
        .filter(|file| saved_paths.contains(&file.path))
        .map(|file| file.path.clone())
        .collect()
}

impl StatusFile {
    pub(crate) fn has_unignored_changes(&self) -> bool {
        !self
            .categories
            .iter()
            .all(|category| matches!(category, ChangeCategory::Ignored))
    }

    pub(crate) fn is_ignored(&self) -> bool {
        self.categories
            .iter()
            .any(|category| matches!(category, ChangeCategory::Ignored))
    }

    pub(crate) fn is_conflicted(&self) -> bool {
        self.kind == ChangeKind::Conflicted
            || self
                .categories
                .iter()
                .any(|category| matches!(category, ChangeCategory::Conflicted))
    }

    pub(crate) fn has_changes_for_scope(&self, scope: DiffScope) -> bool {
        match scope {
            DiffScope::Index => self
                .categories
                .iter()
                .any(|category| matches!(category, ChangeCategory::Staged)),
            DiffScope::WorkingTree => self.categories.iter().any(|category| {
                matches!(
                    category,
                    ChangeCategory::Unstaged | ChangeCategory::Untracked
                )
            }),
            DiffScope::Commit => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_with_categories(categories: Vec<ChangeCategory>) -> StatusFile {
        StatusFile {
            path: "file.txt".into(),
            original_path: None,
            index_status: String::new(),
            worktree_status: String::new(),
            kind: ChangeKind::Modified,
            categories,
            mode_changed: false,
        }
    }

    #[test]
    fn ignored_only_files_are_not_dirty_and_other_categories_are_dirty() {
        assert!(!file_with_categories(vec![ChangeCategory::Ignored]).has_unignored_changes());
        assert!(
            file_with_categories(vec![ChangeCategory::Ignored, ChangeCategory::Unstaged])
                .has_unignored_changes()
        );
        assert!(!file_with_categories(Vec::new()).has_unignored_changes());
    }

    #[test]
    fn conflict_semantics_include_kind_or_category() {
        let mut file = file_with_categories(Vec::new());
        assert!(!file.is_conflicted());

        file.kind = ChangeKind::Conflicted;
        assert!(file.is_conflicted());

        file.kind = ChangeKind::Modified;
        file.categories = vec![ChangeCategory::Conflicted];
        assert!(file.is_conflicted());
    }

    #[test]
    fn ignored_semantics_read_status_categories() {
        assert!(file_with_categories(vec![ChangeCategory::Ignored]).is_ignored());
        assert!(!file_with_categories(vec![ChangeCategory::Unstaged]).is_ignored());
    }

    #[test]
    fn scope_semantics_match_staged_and_working_tree_categories() {
        let file = file_with_categories(vec![ChangeCategory::Staged, ChangeCategory::Untracked]);
        assert!(file.has_changes_for_scope(DiffScope::Index));
        assert!(file.has_changes_for_scope(DiffScope::WorkingTree));
        assert!(!file.has_changes_for_scope(DiffScope::Commit));

        let staged_only = file_with_categories(vec![ChangeCategory::Staged]);
        assert!(!staged_only.has_changes_for_scope(DiffScope::WorkingTree));
    }
}
