use crate::domain::{commit::CommitSearchEntry, error::RepositoryError};

pub(crate) trait HistorySearchIndexPort: Send + Sync {
    fn begin_index_build(&self, repo_id: &str, refs_fingerprint: &str) -> bool;

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
