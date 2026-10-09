use std::{io, path::Path};

use crate::domain::status::StatusSnapshot;

pub(crate) trait StatusReadPort: Send + Sync {
    async fn read_status(
        &self,
        repo_id: String,
        repository_path: &Path,
        paths: &[String],
    ) -> Result<StatusSnapshot, io::Error>;
}
