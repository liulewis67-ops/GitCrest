use std::path::Path;

use crate::api::error::ApiError;

use super::{service as workflows, WorkflowOperation};

pub(crate) fn workflow_operation_for_task(operation: &str) -> Option<WorkflowOperation> {
    match operation {
        "merge" | "pullMerge" => Some(WorkflowOperation::Merge),
        "cherryPick" => Some(WorkflowOperation::CherryPick),
        "revert" => Some(WorkflowOperation::Revert),
        "rebase" | "pullRebase" => Some(WorkflowOperation::Rebase),
        value if shelf_apply_shelf_id(value).is_some() => Some(WorkflowOperation::ShelfApply),
        _ => None,
    }
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
    (matches!(tree.len(), 40 | 64) && tree.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(tree)
}

pub(crate) async fn read_task_recovery_preflight(
    repo_id: &str,
    task_id: &str,
    task_operation: &str,
    repository_path: &Path,
) -> Result<workflows::WorkflowRecoveryPreflight, ApiError> {
    let preflight = if workflow_operation_for_task(task_operation)
        == Some(WorkflowOperation::ShelfApply)
    {
        workflows::read_shelf_apply_preflight(
            repo_id.to_owned(),
            task_id.to_owned(),
            repository_path,
        )
        .await
    } else {
        workflows::read_recovery_preflight(repo_id.to_owned(), task_id.to_owned(), repository_path)
            .await
    };
    preflight.map_err(ApiError::from_workflow_error)
}

pub(crate) fn workflow_recovery_action_allowed(
    preview: &workflows::WorkflowRecoveryPreflight,
    action: workflows::WorkflowRecoveryAction,
) -> bool {
    match action {
        workflows::WorkflowRecoveryAction::Continue => preview.can_continue,
        workflows::WorkflowRecoveryAction::Skip => preview.can_skip,
        workflows::WorkflowRecoveryAction::Abort => preview.can_abort,
    }
}
