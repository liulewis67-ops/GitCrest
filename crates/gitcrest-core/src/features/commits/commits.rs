use serde::Deserialize;

use crate::diff::DiffSelection;
use crate::status::{ChangeCategory, StatusSnapshot};

const MAX_COMMIT_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequest {
    pub message: String,
    #[serde(default)]
    pub amend: bool,
    #[serde(default)]
    pub sign_off: bool,
    #[serde(default)]
    pub sign: bool,
    #[serde(default)]
    pub selections: Vec<CommitSelection>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitSelection {
    pub path: String,
    pub revision: String,
    pub selections: Vec<DiffSelection>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CommitError {
    EmptyMessage,
    MessageTooLarge,
    MessageContainsNul,
    NoStagedChanges,
    ConflictsMustBeResolved,
    AmendRequiresHead,
    InvalidSelection,
    StaleSelection,
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

pub fn validate_selection_shape(selections: &[CommitSelection]) -> Result<(), CommitError> {
    if selections.len() > 512 {
        return Err(CommitError::InvalidSelection);
    }
    let mut paths = std::collections::HashSet::new();
    for selection in selections {
        if selection.path.is_empty()
            || selection.revision.is_empty()
            || selection.selections.is_empty()
            || !paths.insert(&selection.path)
        {
            return Err(CommitError::InvalidSelection);
        }
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
