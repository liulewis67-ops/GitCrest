use std::path::Path;

use crate::api::error::ApiError;

use super::service as workflows;
use crate::{
    domain::workflow::{WorkflowOperation, WorkflowRecoveryAction},
    ports::git::GitReadPort,
};

pub(crate) fn workflow_operation_for_task(operation: &str) -> Option<WorkflowOperation> {
    match operation {
        "resolveConflicts" | "stashApply" | "stashPop" => Some(WorkflowOperation::ResolveConflicts),
        "merge" | "pullMerge" => Some(WorkflowOperation::Merge),
        "cherryPick" => Some(WorkflowOperation::CherryPick),
        "revert" => Some(WorkflowOperation::Revert),
        "rebase" | "pullRebase" => Some(WorkflowOperation::Rebase),
        value if shelf_apply_shelf_id(value).is_some() => Some(WorkflowOperation::ShelfApply),
        value if stash_apply_recovery(value).is_some() => Some(WorkflowOperation::ResolveConflicts),
        _ => None,
    }
}

pub(crate) fn stash_apply_recovery(operation: &str) -> Option<(&str, &str)> {
    let (oid, tree) = operation
        .strip_prefix("stashApply:")
        .or_else(|| operation.strip_prefix("stashPop:"))?
        .split_once(':')?;
    [oid, tree]
        .into_iter()
        .all(|value| {
            matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .then_some((oid, tree))
}

pub(crate) fn shelf_apply_shelf_id(operation: &str) -> Option<&str> {
    let value = operation.strip_prefix("shelfApply:")?;
    let shelf_id = value
        .split_once(':')
        .map_or(value, |(shelf_id, _)| shelf_id);
    (!shelf_id.is_empty()).then_some(shelf_id)
}

pub(crate) fn shelf_apply_before_tree(operation: &str) -> Option<&str> {
    let (_, tree) = operation.strip_prefix("shelfApply:")?.split_once(':')?;
    let tree = tree.strip_suffix(":local").unwrap_or(tree);
    (matches!(tree.len(), 40 | 64) && tree.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(tree)
}

pub(crate) async fn read_task_recovery_preflight<G: GitReadPort>(
    git: &G,
    repo_id: &str,
    task_id: &str,
    task_operation: &str,
    repository_path: &Path,
) -> Result<workflows::WorkflowRecoveryPreflight, ApiError> {
    let operation = workflow_operation_for_task(task_operation);
    let preflight = if matches!(
        operation,
        Some(WorkflowOperation::ShelfApply | WorkflowOperation::ResolveConflicts)
    ) {
        workflows::read_shelf_apply_preflight(
            git,
            repo_id.to_owned(),
            task_id.to_owned(),
            repository_path,
        )
        .await
    } else {
        workflows::read_recovery_preflight(
            git,
            repo_id.to_owned(),
            task_id.to_owned(),
            repository_path,
        )
        .await
    };
    preflight
        .map(|mut preview| {
            if operation == Some(WorkflowOperation::ResolveConflicts) {
                preview.operation = WorkflowOperation::ResolveConflicts;
            }
            preview
        })
        .map_err(ApiError::from_workflow_error)
}

pub(crate) fn workflow_recovery_action_allowed(
    preview: &workflows::WorkflowRecoveryPreflight,
    action: WorkflowRecoveryAction,
) -> bool {
    match action {
        WorkflowRecoveryAction::Continue => preview.can_continue,
        WorkflowRecoveryAction::Skip => preview.can_skip,
        WorkflowRecoveryAction::Abort => preview.can_abort,
    }
}
