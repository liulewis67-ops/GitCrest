use std::{path::Path, process::Stdio, time::Duration};

use serde::Deserialize;
use tokio::process::Command;

/// An image bigger than this is not loaded for comparison; the file itself is still reachable.
pub(super) const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ImageScope {
    WorkingTree,
    Index,
    Commit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum ImageSide {
    Old,
    New,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImageQuery {
    pub path: String,
    pub scope: ImageScope,
    pub side: ImageSide,
    /// The commit, for the commit scope.
    pub commit_oid: Option<String>,
    /// Where the file was before a rename; used for the old side.
    pub original_path: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ImageError {
    InvalidRequest,
    NotFound,
    TooLarge,
    GitUnavailable,
    Failed,
}

/// The image types that can be compared, as `(extension, media type)`.
const IMAGE_TYPES: [(&str, &str); 6] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
];

pub(super) fn media_type(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    IMAGE_TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, media)| *media)
}

/// A repository-relative path of an image type, with nothing that could leave the repository.
pub(super) fn validate_image_path(path: &str) -> Result<&str, ImageError> {
    let bad = path.is_empty()
        || path.len() > 1024
        || path.starts_with('/')
        || path.contains(['\0', '\n', '\r', '\\'])
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || path
            .split('/')
            .next()
            .is_some_and(|first| first.eq_ignore_ascii_case(".git"))
        || media_type(path).is_none();
    if bad {
        Err(ImageError::InvalidRequest)
    } else {
        Ok(path)
    }
}

fn validate_oid(oid: &str) -> Result<&str, ImageError> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(oid)
    } else {
        Err(ImageError::InvalidRequest)
    }
}

async fn git_output(
    repository_path: &Path,
    arguments: &[&str],
) -> Result<(bool, Vec<u8>), ImageError> {
    let output = tokio::time::timeout(
        GIT_TIMEOUT,
        Command::new("git")
            .arg("-C")
            .arg(repository_path)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("GIT_TERMINAL_PROMPT", "0")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| ImageError::Failed)?
    .map_err(|_| ImageError::GitUnavailable)?;
    Ok((output.status.success(), output.stdout))
}

/// The bytes of a stored version, after its size is known to be within the limit.
async fn read_blob(repository_path: &Path, spec: &str) -> Result<Vec<u8>, ImageError> {
    let (found, size) = git_output(repository_path, &["cat-file", "-s", spec]).await?;
    if !found {
        return Err(ImageError::NotFound);
    }
    let size: u64 = String::from_utf8_lossy(&size)
        .trim()
        .parse()
        .map_err(|_| ImageError::Failed)?;
    if size > MAX_IMAGE_BYTES {
        return Err(ImageError::TooLarge);
    }
    let (read, bytes) = git_output(repository_path, &["cat-file", "blob", spec]).await?;
    if read {
        Ok(bytes)
    } else {
        Err(ImageError::NotFound)
    }
}

/// The file as it is on disk, which must be a plain file inside the repository (not a link).
async fn read_working_file(repository_path: &Path, path: &str) -> Result<Vec<u8>, ImageError> {
    let file = repository_path.join(path);
    let metadata = tokio::fs::symlink_metadata(&file)
        .await
        .map_err(|_| ImageError::NotFound)?;
    if !metadata.is_file() {
        return Err(ImageError::NotFound);
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(ImageError::TooLarge);
    }
    tokio::fs::read(&file).await.map_err(|_| ImageError::Failed)
}

pub(super) async fn read_image(
    repository_path: &Path,
    query: &ImageQuery,
) -> Result<(Vec<u8>, &'static str), ImageError> {
    let path = validate_image_path(&query.path)?;
    let media = media_type(path).ok_or(ImageError::InvalidRequest)?;
    let old_path = match &query.original_path {
        Some(original) => validate_image_path(original)?,
        None => path,
    };
    let bytes = match (query.scope, query.side) {
        (ImageScope::WorkingTree, ImageSide::New) => {
            read_working_file(repository_path, path).await?
        }
        (ImageScope::WorkingTree, ImageSide::Old) => {
            read_blob(repository_path, &format!(":{old_path}")).await?
        }
        (ImageScope::Index, ImageSide::New) => {
            read_blob(repository_path, &format!(":{path}")).await?
        }
        (ImageScope::Index, ImageSide::Old) => {
            read_blob(repository_path, &format!("HEAD:{old_path}")).await?
        }
        (ImageScope::Commit, side) => {
            let oid = validate_oid(
                query
                    .commit_oid
                    .as_deref()
                    .ok_or(ImageError::InvalidRequest)?,
            )?;
            match side {
                ImageSide::New => read_blob(repository_path, &format!("{oid}:{path}")).await?,
                ImageSide::Old => read_blob(repository_path, &format!("{oid}^:{old_path}")).await?,
            }
        }
    };
    Ok((bytes, media))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_the_comparable_image_types_by_extension() {
        assert_eq!(media_type("a/b.PNG"), Some("image/png"));
        assert_eq!(media_type("x.jpeg"), Some("image/jpeg"));
        assert_eq!(media_type("logo.svg"), Some("image/svg+xml"));
        assert_eq!(media_type("notes.txt"), None);
        assert_eq!(media_type("png"), None);
    }

    #[test]
    fn refuses_paths_that_are_not_plain_repository_images() {
        for good in ["a.png", "assets/icons/logo.svg"] {
            assert!(validate_image_path(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "/etc/a.png",
            "../a.png",
            "a/../b.png",
            "a//b.png",
            ".git/x.png",
            "a\\b.png",
            "a\nb.png",
            "readme.md",
            "noext",
        ] {
            assert_eq!(
                validate_image_path(bad),
                Err(ImageError::InvalidRequest),
                "{bad}"
            );
        }
    }
}
