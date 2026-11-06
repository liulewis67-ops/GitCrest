use std::path::{Path, PathBuf};

use crate::{
    domain::error::RepositoryError,
    ports::repository::{
        RepositoryFilesystemCheckFuture, RepositoryFilesystemFuture, RepositoryFilesystemPort,
    },
};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RepositoryFilesystemAdapter;

/// Canonical identity for a directory which Git may create later. Resolve the
/// existing prefix, retaining only plain remaining components. Broken symlinks
/// and permission errors fail closed instead of inventing an alternate identity.
pub(crate) async fn canonicalize_prospective(path: &Path) -> Result<PathBuf, RepositoryError> {
    if !path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(RepositoryError::InvalidPath);
    }
    let mut current = path.to_owned();
    let mut suffix = Vec::new();
    loop {
        match tokio::fs::symlink_metadata(&current).await {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(
                    current
                        .file_name()
                        .ok_or(RepositoryError::InvalidPath)?
                        .to_owned(),
                );
                current = current
                    .parent()
                    .ok_or(RepositoryError::InvalidPath)?
                    .to_owned();
            }
            Err(error) => return Err(map_path_error(error)),
        }
    }
    let mut canonical = normalize_canonical_path(
        tokio::fs::canonicalize(current)
            .await
            .map_err(map_path_error)?,
    );
    for name in suffix.into_iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

impl RepositoryFilesystemPort for RepositoryFilesystemAdapter {
    fn canonicalize<'a>(&'a self, path: &'a Path) -> RepositoryFilesystemFuture<'a, PathBuf> {
        Box::pin(async move {
            tokio::fs::canonicalize(path)
                .await
                .map(normalize_canonical_path)
                .map_err(map_path_error)
        })
    }

    fn is_directory<'a>(&'a self, path: &'a Path) -> RepositoryFilesystemFuture<'a, bool> {
        Box::pin(async move {
            tokio::fs::metadata(path)
                .await
                .map(|metadata| metadata.is_dir())
                .map_err(map_path_error)
        })
    }

    fn entry_exists<'a>(&'a self, path: &'a Path) -> RepositoryFilesystemCheckFuture<'a> {
        Box::pin(async move { tokio::fs::symlink_metadata(path).await.is_ok() })
    }

    fn verify_path<'a>(&'a self, path: &'a Path) -> RepositoryFilesystemFuture<'a, ()> {
        Box::pin(async move {
            tokio::fs::metadata(path)
                .await
                .map(|_| ())
                .map_err(map_path_error)
        })
    }

    fn is_available<'a>(&'a self, path: &'a Path) -> RepositoryFilesystemCheckFuture<'a> {
        Box::pin(async move { tokio::fs::metadata(path).await.is_ok() })
    }
}

fn map_path_error(error: std::io::Error) -> RepositoryError {
    match error.kind() {
        std::io::ErrorKind::NotFound => RepositoryError::PathNotFound,
        std::io::ErrorKind::PermissionDenied => RepositoryError::PathPermissionDenied,
        _ => RepositoryError::PathNotFound,
    }
}

#[cfg(windows)]
fn normalize_canonical_path(path: PathBuf) -> PathBuf {
    let path = path.to_string_lossy();
    if let Some(unc_path) = path.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{unc_path}"))
    } else if let Some(drive_path) = path.strip_prefix(r"\\?\") {
        PathBuf::from(drive_path)
    } else {
        PathBuf::from(path.as_ref())
    }
}

#[cfg(not(windows))]
fn normalize_canonical_path(path: PathBuf) -> PathBuf {
    path
}
