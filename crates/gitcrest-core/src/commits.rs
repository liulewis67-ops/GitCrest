use serde::Deserialize;

use crate::status::{ChangeCategory, StatusSnapshot};

const MAX_COMMIT_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequest {
    pub message: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CommitError {
    EmptyMessage,
    MessageTooLarge,
    MessageContainsNul,
    NoStagedChanges,
    ConflictsMustBeResolved,
}

pub fn validate_message(message: &str) -> Result<(), CommitError> {
    if message.trim().is_empty() {
        return Err(CommitError::EmptyMessage);
    }
    if message.len() > MAX_COMMIT_MESSAGE_BYTES {
        return Err(CommitError::MessageTooLarge);
    }
    if message.contains('\0') {
        return Err(CommitError::MessageContainsNul);
    }
    Ok(())
}

pub fn validate_snapshot(snapshot: &StatusSnapshot) -> Result<(), CommitError> {
    if snapshot
        .files
        .iter()
        .any(|file| file.categories.contains(&ChangeCategory::Conflicted))
    {
        return Err(CommitError::ConflictsMustBeResolved);
    }
    if !snapshot
        .files
        .iter()
        .any(|file| file.categories.contains(&ChangeCategory::Staged))
    {
        return Err(CommitError::NoStagedChanges);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_commit_messages_without_trimming_the_message() {
        assert_eq!(validate_message("\n  "), Err(CommitError::EmptyMessage));
        assert_eq!(
            validate_message("subject\0body"),
            Err(CommitError::MessageContainsNul)
        );
        assert_eq!(
            validate_message(&"x".repeat(MAX_COMMIT_MESSAGE_BYTES + 1)),
            Err(CommitError::MessageTooLarge)
        );
        assert_eq!(validate_message("  subject  \n\nbody\n"), Ok(()));
    }
}
