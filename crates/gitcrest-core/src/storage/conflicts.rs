use std::{
    io,
    path::{Component, Path, PathBuf},
};

use tokio::{fs, io::AsyncWriteExt};

use crate::{
    domain::error::ConflictError,
    ports::conflicts::{ConflictGitFuture, ConflictWorktreePort},
};

const MAX_CONFLICT_FILE_BYTES: usize = 1024 * 1024;

pub(crate) struct ConflictWorktreeAdapter;

impl ConflictWorktreePort for ConflictWorktreeAdapter {
    fn read_conflict_worktree_file<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
    ) -> ConflictGitFuture<'a, Option<Vec<u8>>> {
        Box::pin(async move {
            let path = safe_worktree_target(repository_path, relative_path).await?;
            let metadata = match fs::symlink_metadata(&path).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(ConflictError::Io),
            };
            if !metadata.file_type().is_file() {
                return Err(ConflictError::Binary);
            }
            if metadata.len() > MAX_CONFLICT_FILE_BYTES as u64 {
                return Err(ConflictError::TooLarge);
            }
            let bytes = fs::read(path).await.map_err(|_| ConflictError::Io)?;
            if bytes.len() > MAX_CONFLICT_FILE_BYTES {
                return Err(ConflictError::TooLarge);
            }
            Ok(Some(bytes))
        })
    }

    fn write_conflict_worktree_file<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
        content: &'a [u8],
    ) -> ConflictGitFuture<'a, ()> {
        Box::pin(async move {
            if content.len() > MAX_CONFLICT_FILE_BYTES {
                return Err(ConflictError::TooLarge);
            }
            let path = safe_worktree_target(repository_path, relative_path).await?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(path)
                .await
                .map_err(|_| ConflictError::Io)?;
            file.write_all(content)
                .await
                .map_err(|_| ConflictError::Io)?;
            file.flush().await.map_err(|_| ConflictError::Io)
        })
    }
}

async fn safe_worktree_target(
    repository_path: &Path,
    relative_path: &str,
) -> Result<PathBuf, ConflictError> {
    if relative_path.is_empty()
        || relative_path.len() > 4096
        || relative_path.contains('\0')
        || Path::new(relative_path).is_absolute()
        || Path::new(relative_path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(ConflictError::InvalidPath);
    }
    let root = fs::canonicalize(repository_path)
        .await
        .map_err(|_| ConflictError::Io)?;
    let joined = root.join(PathBuf::from(relative_path));
    let parent = joined.parent().ok_or(ConflictError::InvalidPath)?;
    let canonical_parent = fs::canonicalize(parent).await.map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            ConflictError::FileNotFound
        } else {
            ConflictError::Io
        }
    })?;
    if !canonical_parent.starts_with(&root) {
        return Err(ConflictError::InvalidPath);
    }
    let file_name = joined.file_name().ok_or(ConflictError::InvalidPath)?;
    let path = canonical_parent.join(file_name);
    match fs::symlink_metadata(&path).await {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err(ConflictError::Binary),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(ConflictError::Io),
    }
    Ok(path)
}
