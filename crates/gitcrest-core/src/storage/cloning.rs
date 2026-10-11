use std::path::Path;

use crate::ports::cloning::{CloneFilesystemFuture, CloneFilesystemPort};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct CloneFilesystemAdapter;

impl CloneFilesystemPort for CloneFilesystemAdapter {
    fn canonicalize_directory<'a>(
        &'a self,
        path: &'a Path,
    ) -> CloneFilesystemFuture<'a, std::path::PathBuf> {
        Box::pin(async move { tokio::fs::canonicalize(path).await })
    }

    fn is_directory<'a>(&'a self, path: &'a Path) -> CloneFilesystemFuture<'a, bool> {
        Box::pin(async move { Ok(tokio::fs::metadata(path).await?.is_dir()) })
    }

    fn path_exists<'a>(&'a self, path: &'a Path) -> CloneFilesystemFuture<'a, bool> {
        Box::pin(async move {
            match tokio::fs::symlink_metadata(path).await {
                Ok(_) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(error),
            }
        })
    }

    fn rename_path<'a>(
        &'a self,
        source: &'a Path,
        destination: &'a Path,
    ) -> CloneFilesystemFuture<'a, ()> {
        Box::pin(async move { tokio::fs::rename(source, destination).await })
    }

    fn cleanup_stage<'a>(&'a self, path: &'a Path) -> CloneFilesystemFuture<'a, ()> {
        Box::pin(async move {
            let metadata = match tokio::fs::symlink_metadata(path).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error),
            };
            if metadata.file_type().is_symlink() || metadata.is_file() {
                tokio::fs::remove_file(path).await
            } else if metadata.is_dir() {
                tokio::fs::remove_dir_all(path).await
            } else {
                Ok(())
            }
        })
    }
}
