use std::path::{Component, Path};

use crate::{
    domain::{diff::DiffWorktreeEntryKind, error::DiffError},
    ports::diff::{DiffWorktreeFuture, DiffWorktreePort},
};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct DiffWorktreeAdapter;

impl DiffWorktreePort for DiffWorktreeAdapter {
    fn inspect_entry<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
    ) -> DiffWorktreeFuture<'a, DiffWorktreeEntryKind> {
        Box::pin(async move {
            validate_relative_path(relative_path)?;
            let components = Path::new(relative_path).components().collect::<Vec<_>>();
            let mut current = repository_path.to_path_buf();
            for (index, component) in components.iter().enumerate() {
                let Component::Normal(component) = component else {
                    return Err(DiffError::InvalidPath);
                };
                current.push(component);
                let metadata = match tokio::fs::symlink_metadata(&current).await {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        if index + 1 == components.len() {
                            return Ok(DiffWorktreeEntryKind::Missing);
                        }
                        return Err(DiffError::PathNotFound);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                        return Err(DiffError::PermissionDenied);
                    }
                    Err(_) => return Err(DiffError::PathNotFound),
                };
                if metadata.file_type().is_symlink() {
                    return Ok(DiffWorktreeEntryKind::Symlink);
                }
                if index + 1 < components.len() && !metadata.is_dir() {
                    return Err(DiffError::PathNotFound);
                }
                if index + 1 == components.len() && metadata.is_dir() {
                    return Ok(DiffWorktreeEntryKind::Directory);
                }
            }
            Ok(DiffWorktreeEntryKind::Regular)
        })
    }
}

fn validate_relative_path(value: &str) -> Result<(), DiffError> {
    let bytes = value.as_bytes();
    let has_windows_drive_prefix =
        bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if value.is_empty()
        || value.chars().any(char::is_control)
        || has_windows_drive_prefix
        || value.contains('\\')
        || Path::new(value).is_absolute()
        || !Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(DiffError::InvalidPath);
    }
    Ok(())
}
