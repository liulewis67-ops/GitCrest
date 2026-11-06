use std::path::{Component, Path, PathBuf};

use super::workspace::PipelineStepError;

/// Resolve the trusted data anchor, then reject links in every application-
/// managed component. Never canonicalize a run link and delete its target.
pub(super) async fn directory(
    data: &Path,
    components: &[&str],
) -> Result<PathBuf, PipelineStepError> {
    let invalid =
        || PipelineStepError::workspace("the managed workspace path could not be verified");
    let mut path = crate::storage::repository_paths::canonicalize_prospective(data)
        .await
        .map_err(|_| invalid())?;
    for name in std::iter::once("pipelines").chain(components.iter().copied()) {
        if name.is_empty()
            || name.contains(['/', '\\', ':'])
            || name.ends_with([' ', '.'])
            || !matches!(
                Path::new(name).components().next(),
                Some(Component::Normal(_))
            )
        {
            return Err(invalid());
        }
        path.push(name);
        match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(invalid());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err(invalid());
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(invalid()),
        }
    }
    let current = crate::storage::repository_paths::canonicalize_prospective(&path)
        .await
        .map_err(|_| invalid())?;
    if current != path {
        return Err(invalid());
    }
    Ok(path)
}
