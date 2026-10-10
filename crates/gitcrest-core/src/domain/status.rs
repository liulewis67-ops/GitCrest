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

impl StatusFile {
    pub(crate) fn has_unignored_changes(&self) -> bool {
        !self
            .categories
            .iter()
            .all(|category| matches!(category, ChangeCategory::Ignored))
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
}
