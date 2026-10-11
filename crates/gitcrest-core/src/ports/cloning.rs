use std::{
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
};

pub(crate) trait CloneFilesystemPort: Send + Sync {
    fn canonicalize_directory<'a>(&'a self, path: &'a Path) -> CloneFilesystemFuture<'a, PathBuf>;

    fn is_directory<'a>(&'a self, path: &'a Path) -> CloneFilesystemFuture<'a, bool>;

    fn path_exists<'a>(&'a self, path: &'a Path) -> CloneFilesystemFuture<'a, bool>;

    fn rename_path<'a>(
        &'a self,
        source: &'a Path,
        destination: &'a Path,
    ) -> CloneFilesystemFuture<'a, ()>;

    fn cleanup_stage<'a>(&'a self, path: &'a Path) -> CloneFilesystemFuture<'a, ()>;
}

pub(crate) type CloneFilesystemFuture<'a, T> =
    Pin<Box<dyn Future<Output = io::Result<T>> + Send + 'a>>;
