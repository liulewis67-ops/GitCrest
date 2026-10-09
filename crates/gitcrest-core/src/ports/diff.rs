use std::path::Path;

use crate::domain::{diff::DiffScope, error::DiffError};

pub(crate) trait DiffGitPort: Send + Sync {
    async fn read_file_patch(
        &self,
        repository_path: &Path,
        relative_path: &str,
        scope: DiffScope,
        untracked: bool,
    ) -> Result<Vec<u8>, DiffError>;

    async fn read_commit_file_patch(
        &self,
        repository_path: &Path,
        oid: &str,
        parent_oid: Option<&str>,
        relative_path: &str,
    ) -> Result<Vec<u8>, DiffError>;
}
