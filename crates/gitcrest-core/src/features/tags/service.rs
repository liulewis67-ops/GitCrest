use std::path::Path;

const MAX_TAG_MESSAGE_BYTES: usize = 8 * 1024;

use crate::{domain::error::GitAdapterError, ports::tags::TagGitPort};

#[cfg(test)]
use crate::git::tags::GitTagAdapter;

use super::dto::CreatedTag;

#[derive(Debug, PartialEq, Eq)]
pub enum TagError {
    Invalid,
    AlreadyExists,
    CommitNotFound,
    /// No tag with this name exists (locally, or on the remote).
    NotFound,
    /// The tag moved after it was reviewed.
    Stale,
    /// The remote already has a tag with this name that points somewhere else.
    RemoteDiffers,
    GitUnavailable,
    TimedOut,
    GitFailed,
}

pub struct CreateTagRequest {
    pub name: String,
    pub oid: String,
    pub message: String,
}

pub async fn create(
    repo_id: String,
    repository_path: &Path,
    request: CreateTagRequest,
    git: &dyn TagGitPort,
) -> Result<CreatedTag, TagError> {
    let ref_name = format!("refs/tags/{}", request.name);
    if request.name.is_empty()
        || request.name.len() > 255
        || request.name.chars().any(char::is_control)
        || request.oid.len() != 40 && request.oid.len() != 64
        || !request.oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        || request.message.len() > MAX_TAG_MESSAGE_BYTES
        || request.message.contains('\0')
    {
        return Err(TagError::Invalid);
    }

    if !git
        .check_ref_name(repository_path, &ref_name)
        .await
        .map_err(map_git_error)?
    {
        return Err(TagError::Invalid);
    }
    if !git
        .object_is_commit(repository_path, &request.oid)
        .await
        .map_err(map_git_error)?
    {
        return Err(TagError::CommitNotFound);
    }

    let existing = git
        .list_tag_names(repository_path)
        .await
        .map_err(map_git_error)?;
    if existing.iter().any(|line| line == &ref_name) {
        return Err(TagError::AlreadyExists);
    }
    git.create_annotated_tag(
        repository_path,
        &request.name,
        &request.oid,
        &request.message,
    )
    .await
    .map_err(map_git_error)?;

    Ok(CreatedTag {
        repo_id,
        name: request.name,
        full_name: ref_name,
        oid: request.oid,
    })
}

fn map_git_error(error: GitAdapterError) -> TagError {
    match error {
        GitAdapterError::Unavailable => TagError::GitUnavailable,
        GitAdapterError::TimedOut => TagError::TimedOut,
        GitAdapterError::OutputTooLarge | GitAdapterError::Failed => TagError::GitFailed,
        GitAdapterError::ReferenceAlreadyExists => TagError::AlreadyExists,
    }
}

#[cfg(test)]
mod tests {
    use std::{path::Path, process::Command as StdCommand};

    use super::*;

    fn git(path: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    #[tokio::test]
    async fn creates_annotated_tags_without_overwriting_existing_refs() {
        let git_adapter = GitTagAdapter;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "--quiet"]);
        git(path, &["config", "user.name", "Tag Test"]);
        git(path, &["config", "user.email", "tag@example.invalid"]);
        std::fs::write(path.join("readme.txt"), "tag fixture\n").unwrap();
        git(path, &["add", "."]);
        git(path, &["commit", "--quiet", "-m", "tag fixture"]);
        let oid = git(path, &["rev-parse", "HEAD"]);

        let created = create(
            "repo_tag_test".into(),
            path,
            CreateTagRequest {
                name: "v1.0.0".into(),
                oid: oid.clone(),
                message: "Release 1.0.0".into(),
            },
            &git_adapter,
        )
        .await
        .unwrap();
        assert_eq!(created.full_name, "refs/tags/v1.0.0");
        assert_eq!(git(path, &["cat-file", "-t", "refs/tags/v1.0.0"]), "tag");
        assert!(matches!(
            create(
                "repo_tag_test".into(),
                path,
                CreateTagRequest {
                    name: "v1.0.0".into(),
                    oid,
                    message: "duplicate".into()
                },
                &git_adapter,
            )
            .await,
            Err(TagError::AlreadyExists)
        ));
        assert!(matches!(
            create(
                "repo_tag_test".into(),
                path,
                CreateTagRequest {
                    name: "../bad".into(),
                    oid: "a".repeat(40),
                    message: String::new()
                },
                &git_adapter,
            )
            .await,
            Err(TagError::Invalid)
        ));
    }
}
