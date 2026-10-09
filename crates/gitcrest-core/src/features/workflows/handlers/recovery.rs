use axum::{
    extract::{rejection::JsonRejection, rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use super::super::dto::{
    WorkflowRecoveryPreflightDto, WorkflowRecoveryQuery, WorkflowRecoveryRequest,
};
use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::diff::DiffScope,
    domain::status::ChangeKind,
    domain::undo::{UndoOperation, UndoRecord},
    domain::workflow::WorkflowRecoveryAction,
    domain::{staging::StagingOperation, time::unix_time_ms},
    features::shelves,
    features::tasks,
    features::tasks::{TaskFailure, TaskSnapshot},
    ports::git::GitReadPort,
    state::AppState,
};

pub(in crate::features::workflows) async fn preflight_repository_workflow_recovery(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<WorkflowRecoveryQuery>, QueryRejection>,
) -> Result<Json<WorkflowRecoveryPreflightDto>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Workflow recovery preflight requires a waiting workflow taskId.",
        )
    })?;
    let task = state.tasks.get(&query.task_id).await.ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::TaskNotFound,
            "The workflow task is no longer available.",
        )
    })?;
    if task.repo_id.as_deref() != Some(repo_id.as_str())
        || task.status != crate::features::tasks::TaskStatus::WaitingForInput
        || crate::features::workflows::recovery::workflow_operation_for_task(&task.operation)
            .is_none()
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowNoActiveOperation,
            "Recovery requires a waiting merge, pull, cherry-pick, or revert task for this repository.",
        ));
    }
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let preview = crate::features::workflows::recovery::read_task_recovery_preflight(
        &state.git_commands,
        &repo_id,
        &query.task_id,
        &task.operation,
        &target.repository_path,
    )
    .await?;
    if crate::features::workflows::recovery::workflow_operation_for_task(&task.operation)
        != Some(preview.operation)
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowNoActiveOperation,
            "The repository operation no longer matches the waiting task. Refresh task state.",
        ));
    }
    Ok(Json(preview.into()))
}

pub(in crate::features::workflows) async fn recover_repository_workflow(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<WorkflowRecoveryRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Workflow recovery requires a waiting task, action, operation, HEAD, and conflict snapshot.",
        )
    })?;
    let action = WorkflowRecoveryAction::from(request.action);
    if request.expected_conflicted_paths.len() > 200 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Workflow recovery accepts at most 200 reviewed conflict paths.",
        ));
    }
    let waiting_task = state.tasks.get(&request.task_id).await.ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::TaskNotFound,
            "The workflow task is no longer available.",
        )
    })?;
    if waiting_task.repo_id.as_deref() != Some(repo_id.as_str())
        || waiting_task.status != tasks::TaskStatus::WaitingForInput
        || crate::features::workflows::recovery::workflow_operation_for_task(
            &waiting_task.operation,
        ) != Some(request.expected_operation)
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowNoActiveOperation,
            "Recovery requires the matching waiting workflow task.",
        ));
    }
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let preview = crate::features::workflows::recovery::read_task_recovery_preflight(
        &state.git_commands,
        &repo_id,
        &request.task_id,
        &waiting_task.operation,
        &target.repository_path,
    )
    .await?;
    if preview.operation != request.expected_operation
        || preview.head_oid.as_deref() != Some(request.expected_head_oid.as_str())
        || preview.conflicted_paths != request.expected_conflicted_paths
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowRecoveryStale,
            "The Git operation or conflict set changed after recovery review. Refresh the preview.",
        ));
    }
    if !crate::features::workflows::recovery::workflow_recovery_action_allowed(&preview, action) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowRecoveryNotAllowed,
            "Resolve conflicts before continuing. Skip and abort are available only when the operation can preserve other worktree edits.",
        ));
    }

    let command = state.git_commands.clone();
    let repositories = state.repositories.clone();
    let status_service = state.status.clone();
    let tasks = state.tasks.clone();
    let task_repo_id = repo_id.clone();
    let waiting_task_id = request.task_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let expected_operation = request.expected_operation;
    let expected_head_oid = request.expected_head_oid;
    let expected_conflicted_paths = request.expected_conflicted_paths;
    let waiting_task_operation = waiting_task.operation.clone();
    let operation = match action {
        WorkflowRecoveryAction::Continue => "workflowContinue",
        WorkflowRecoveryAction::Skip => "workflowSkip",
        WorkflowRecoveryAction::Abort => "workflowAbort",
    };
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            operation,
            move |context| async move {
                let current = crate::features::workflows::recovery::read_task_recovery_preflight(
                    &command,
                    &task_repo_id,
                    &waiting_task_id,
                    &waiting_task_operation,
                    &path,
                )
                .await
                .map_err(|_| TaskFailure::Failed("The Git operation could not be rechecked. Refresh repository state before recovery.".into()))?;
                if current.operation != expected_operation
                    || current.head_oid.as_deref() != Some(expected_head_oid.as_str())
                    || current.conflicted_paths != expected_conflicted_paths
                    || !crate::features::workflows::recovery::workflow_recovery_action_allowed(&current, action)
                {
                    return Err(TaskFailure::Failed(
                        "The Git operation changed before recovery could start. Review its current state.".into(),
                    ));
                }
                let task_context = context.clone();
                if expected_operation == crate::domain::workflow::WorkflowOperation::ShelfApply {
                    let shelf_id = crate::features::workflows::recovery::shelf_apply_shelf_id(&waiting_task_operation)
                        .ok_or_else(|| TaskFailure::Failed("The shelf apply task no longer identifies its saved patch.".into()))?;
                    let before_tree = crate::features::workflows::recovery::shelf_apply_before_tree(&waiting_task_operation)
                        .ok_or_else(|| TaskFailure::Failed("The shelf apply task has no safe pre-apply index snapshot. The shelf was retained.".into()))?;
                    let shelf = shelves::load_shelf_record(&repositories, &task_repo_id, shelf_id)
                        .await
                        .map_err(|_| TaskFailure::Failed("The saved shelf is unavailable. Conflicts remain in the working tree.".into()))?;
                    if shelf.snapshot.scope == Some(DiffScope::WorkingTree) {
                        command
                            .execute_staging(
                                &path,
                                StagingOperation::UnstagePaths(shelf.snapshot.paths.clone()),
                                context.clone(),
                            )
                            .await?;
                    }
                    let undo_scope = match shelf.snapshot.scope {
                        Some(scope @ (DiffScope::Index | DiffScope::WorkingTree)) => scope,
                        Some(DiffScope::Commit) | None => {
                            return Err(TaskFailure::Failed(
                                "The saved shelf has no safe restore scope. The shelf was retained."
                                    .into(),
                            ));
                        }
                    };
                    let after_tree = command.read_index_tree(&path).await?;
                    let reverse_patch = match undo_scope {
                        DiffScope::Index => command
                            .diff_index_trees_for_paths(&path, before_tree, &after_tree, &shelf.snapshot.paths)
                            .await?,
                        DiffScope::WorkingTree => {
                            let status = status_service
                                .snapshot(&task_repo_id)
                                .await
                                .map_err(|_| TaskFailure::Failed("The shelf was resolved, but its result could not be checked. The shelf was retained.".into()))?;
                            if status.files.iter().any(|file| {
                                file.kind == ChangeKind::Untracked
                                    && shelf.snapshot.paths.contains(&file.path)
                            }) {
                                Vec::new()
                            } else {
                                command
                                    .diff_tree_to_worktree_paths(&path, before_tree, &shelf.snapshot.paths)
                                    .await?
                            }
                        }
                        DiffScope::Commit => {
                            return Err(TaskFailure::Failed(
                                "The saved shelf has no safe restore scope. The shelf was retained."
                                    .into(),
                            ));
                        }
                    };
                    let undo_saved = if reverse_patch.is_empty() {
                        false
                    } else {
                        let record = UndoRecord {
                            operation_task_id: waiting_task_id.clone(),
                            repo_id: task_repo_id.clone(),
                            created_at_ms: unix_time_ms(),
                            reverse_patch,
                            operation: UndoOperation::ShelfApply {
                                scope: undo_scope,
                            },
                            restore_shelf: Some(shelf.snapshot.clone()),
                            restore_shelf_patch: Some(shelf.patch.clone()),
                        };
                        let store = repositories.store();
                        tokio::task::spawn_blocking(move || store.save_undo_record(&record))
                            .await
                            .is_ok_and(|result| result.is_ok())
                    };
                    if !undo_saved {
                        task_context.log("The shelf was resolved, but no safe undo snapshot could be saved. The original shelf was retained.").await;
                    } else {
                        let store = repositories.store();
                        let delete_repo_id = task_repo_id.clone();
                        let delete_shelf_id = shelf_id.to_owned();
                        let deleted = tokio::task::spawn_blocking(move || store.delete_shelf(&delete_repo_id, &delete_shelf_id))
                            .await
                            .is_ok_and(|result| result.is_ok_and(|deleted| deleted));
                        if !deleted {
                            task_context.log("The shelf was resolved and undo data was saved, but its shelf entry could not be removed. Undo remains available.").await;
                        }
                    }
                    tasks
                        .resolve_waiting_for_input(
                            &waiting_task_id,
                            tasks::TaskStatus::Succeeded,
                            if undo_saved {
                                "The shelf changes were resolved and applied."
                            } else {
                                "The shelf changes were resolved; the original shelf was retained because a safe undo snapshot was unavailable."
                            },
                        )
                        .await
                        .map_err(|_| TaskFailure::Failed("The shelf was resolved, but the waiting task state could not be saved.".into()))?;
                    if repositories.refresh_metadata(&task_repo_id).await.is_err() {
                        task_context.log("Repository metadata refresh failed after shelf recovery; refresh the repository before the next write.").await;
                    }
                    return Ok(Some(if undo_saved {
                        "The shelf conflicts were resolved, the saved changes were kept unstaged, and undo was recorded.".into()
                    } else {
                        "The shelf conflicts were resolved and the original shelf was retained because no safe undo snapshot was available.".into()
                    }));
                }
                let result = command
                    .execute_workflow_recovery(&path, expected_operation, action, context)
                    .await;
                if result.is_ok() {
                    if !matches!(command.read_operation(&path).await, Ok(None)) {
                        return Err(TaskFailure::WaitingForInput(
                            "The Git operation is still active. Review repository state and choose a recovery action.".into(),
                        ));
                    }
                    let waiting_status = if action == WorkflowRecoveryAction::Abort {
                        tasks::TaskStatus::Cancelled
                    } else {
                        tasks::TaskStatus::Succeeded
                    };
                    let waiting_message = match action {
                        WorkflowRecoveryAction::Continue => {
                            "The Git operation was continued successfully."
                        }
                        WorkflowRecoveryAction::Skip => {
                            "The conflicted Git change was skipped successfully."
                        }
                        WorkflowRecoveryAction::Abort => {
                            "The Git operation was aborted safely."
                        }
                    };
                    if tasks
                        .resolve_waiting_for_input(
                            &waiting_task_id,
                            waiting_status,
                            waiting_message,
                        )
                        .await
                        .is_err()
                    {
                        task_context
                            .log("The Git operation recovered, but its waiting task status could not be saved. Refresh task state.")
                            .await;
                    }
                    if repositories.refresh_metadata(&task_repo_id).await.is_err() {
                        task_context
                            .log("Repository metadata refresh failed after workflow recovery; refresh the repository before the next write.")
                            .await;
                    }
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
