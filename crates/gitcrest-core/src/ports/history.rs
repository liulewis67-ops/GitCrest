use crate::domain::{commit::CommitSearchEntry, error::RepositoryError};

pub(crate) trait HistorySearchIndexPort: Send + Sync {
    fn begin_index_build(&self, repo_id: &str, refs_fingerprint: &str) -> bool;

    fn is_index_building(&self, repo_id: &str) -> bool;

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

    fn replace_index(
        &self,
        repo_id: &str,
        refs_fingerprint: &str,
        entries: Vec<CommitSearchEntry>,
    ) -> Result<(), RepositoryError>;
}
