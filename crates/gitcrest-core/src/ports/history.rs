use crate::domain::{commit::CommitSearchEntry, error::RepositoryError};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HistoryIndexBasis {
    /// Sorted, de-duplicated commit ids the indexed history was walked from.
    pub tips: Vec<String>,
    /// Newest committer time (seconds) among all indexed commits.
    pub max_commit_time: i64,
}

pub(crate) trait HistorySearchIndexPort: Send + Sync {
    fn begin_index_build(&self, repo_id: &str, refs_fingerprint: &str) -> bool;

    fn is_index_building(&self, repo_id: &str) -> bool;

    /// True when a previously built index exists, even if its refs fingerprint is stale.
    fn has_index(&self, repo_id: &str) -> bool;

    fn index_build_failed(&self, repo_id: &str, refs_fingerprint: &str) -> bool;

    fn fail_index_build(&self, repo_id: &str, refs_fingerprint: &str);

    fn finish_index_build(&self, repo_id: &str);

    fn search_messages(
        &self,
        repo_id: &str,
        refs_fingerprint: &str,
        query: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Option<Vec<CommitSearchEntry>>, RepositoryError>;

    /// Reachability tips and newest commit time recorded with the last full or
    /// incremental build; None when the index predates this bookkeeping.
    fn index_basis(&self, repo_id: &str) -> Option<HistoryIndexBasis>;

    fn replace_index(
        &self,
        repo_id: &str,
        refs_fingerprint: &str,
        basis: HistoryIndexBasis,
        entries: Vec<CommitSearchEntry>,
    ) -> Result<(), RepositoryError>;

    /// Prepends `entries` (already in Git log order, newest first) in front of the
    /// existing documents. Returns false, writing nothing, when the stored tips no
    /// longer equal `expected_tips`.
    fn prepend_index(
        &self,
        repo_id: &str,
        refs_fingerprint: &str,
        expected_tips: &[String],
        basis: HistoryIndexBasis,
        entries: Vec<CommitSearchEntry>,
    ) -> Result<bool, RepositoryError>;
}
