use axum::{
    extract::{rejection::JsonRejection, rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use super::{
    dto::{
        RebasePreviewQuery, RebaseRequest, RebaseRollbackRequest, ResetPreviewQuery, ResetRequest,
        ResetRestoreRequest, WorkflowPreflightQuery, WorkflowRecoveryQuery, WorkflowRequest,
    },
    service as workflows,
};
use crate::{
    api::error::{ApiError, ApiErrorCode},
    rebase, reset,
    state::AppState,
    tasks::{TaskFailure, TaskSnapshot},
};
pub(super) async fn preflight_repository_workflow(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<WorkflowPreflightQuery>, QueryRejection>,
) -> Result<Json<workflows::WorkflowPreflight>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Workflow preflight requires an action and targetOid.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    workflows::read_preflight(
        repo_id,
        &target.repository_path,
        query.action,
        &query.target_oid,
    )
    .await
    .map(Json)
    .map_err(ApiError::from_workflow_error)
}

pub(super) async fn preflight_repository_workflow_recovery(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<WorkflowRecoveryQuery>, QueryRejection>,
) -> Result<Json<workflows::WorkflowRecoveryPreflight>, ApiError> {
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
        || task.status != crate::tasks::TaskStatus::WaitingForInput
        || crate::workflow_operation_for_task(&task.operation).is_none()
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowNoActiveOperation,
            "Recovery requires a waiting merge, pull, cherry-pick, or revert task for this repository.",
        ));
    }
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let preview = crate::read_task_recovery_preflight(
        &repo_id,
        &query.task_id,
        &task.operation,
        &target.repository_path,
    )
    .await?;
    if crate::workflow_operation_for_task(&task.operation) != Some(preview.operation) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowNoActiveOperation,
            "The repository operation no longer matches the waiting task. Refresh task state.",
        ));
    }
    Ok(Json(preview))
}

pub(super) async fn start_repository_workflow(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<WorkflowRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A workflow action, targetOid, and expectedHeadOid are required.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let preview = workflows::read_preflight(
        repo_id.clone(),
        &target.repository_path,
        request.action,
        &request.target_oid,
    )
    .await
    .map_err(ApiError::from_workflow_error)?;
    if preview.head_oid.as_deref() != Some(request.expected_head_oid.as_str())
        || preview.target_oid != request.target_oid
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowPreflightStale,
            "HEAD or the selected commit changed after preflight. Refresh the workflow preview.",
        ));
    }
    if !preview.can_start {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowRequiresClean,
            "Merge, cherry-pick, or revert requires a clean worktree and no Git operation in progress.",
        ));
    }
    let command = state.git_commands.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let action = request.action;
    let target_oid = request.target_oid;
    let expected_head_oid = request.expected_head_oid;
    let operation = match action {
        workflows::WorkflowAction::Merge => "merge",
        workflows::WorkflowAction::CherryPick => "cherryPick",
        workflows::WorkflowAction::Revert => "revert",
    };
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            operation,
            move |context| async move {
                let current = workflows::read_preflight(
                    task_repo_id.clone(),
                    &path,
                    action,
                    &target_oid,
                )
                .await
                .map_err(|_| {
                    TaskFailure::Failed(
                        "Workflow preconditions could not be rechecked. Refresh repository state.".into(),
                    )
                })?;
                if current.head_oid.as_deref() != Some(expected_head_oid.as_str())
                    || current.target_oid != target_oid
                    || !current.can_start
                {
                    return Err(TaskFailure::Failed(
                        "Workflow preconditions changed before Git could start. Review the current repository state.".into(),
                    ));
                }
                let task_context = context.clone();
                let result = command
                    .execute_workflow(&path, action, &target_oid, context)
                    .await;
                if result.is_ok() && repositories.refresh_metadata(&task_repo_id).await.is_err() {
                    task_context
                        .log("Repository metadata refresh failed after the Git operation; refresh the repository before the next write.")
                        .await;
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn preflight_repository_rebase(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<RebasePreviewQuery>, QueryRejection>,
) -> Result<Json<rebase::RebasePreview>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Rebase preview requires an ontoOid commit.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    rebase::read_preview(repo_id, &target.repository_path, &query.onto_oid)
        .await
        .map(Json)
        .map_err(ApiError::from_workflow_error)
}

pub(super) async fn start_repository_rebase(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RebaseRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Starting a rebase requires the reviewed HEAD, onto commit, and preview revision.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let preview = rebase::read_preview(
        repo_id.clone(),
        &target.repository_path,
        &request.expected_onto_oid,
    )
    .await
    .map_err(ApiError::from_workflow_error)?;
    if preview.head_oid.as_deref() != Some(request.expected_head_oid.as_str())
        || preview.onto_oid != request.expected_onto_oid
        || preview.preview_revision != request.preview_revision
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowPreflightStale,
            "HEAD, target, or commit list changed after review. Refresh the rebase preview.",
        ));
    }
    if !preview.can_start {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowRequiresClean,
            "Rebase requires a clean branch, a non-empty bounded commit list, and no Git operation in progress.",
        ));
    }
    rebase::validate_todo(
        &preview,
        &request.todo,
        request.confirm_drop,
        request.confirm_published_rewrite,
    )
    .map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            match error {
                rebase::RebaseTodoError::StaleCommit => {
                    "The todo must contain each reviewed commit exactly once."
                }
                rebase::RebaseTodoError::EmptySequence => {
                    "A rebase todo must keep at least one commit."
                }
                rebase::RebaseTodoError::InvalidActionOrder => {
                    "Squash and fixup require an earlier non-dropped commit."
                }
                rebase::RebaseTodoError::DropConfirmationRequired => {
                    "Dropping commits requires explicit confirmation."
                }
                rebase::RebaseTodoError::PublishedConfirmationRequired => {
                    "Rewriting commits already present on a remote requires explicit confirmation."
                }
                rebase::RebaseTodoError::MessageRequired => {
                    "Every reword action requires a non-empty replacement message."
                }
                rebase::RebaseTodoError::UnexpectedMessage => {
                    "Replacement messages are only accepted for reword actions."
                }
            },
        )
    })?;
    let command = state.git_commands.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let expected_head_oid = request.expected_head_oid;
    let onto_oid = request.expected_onto_oid;
    let expected_preview_revision = request.preview_revision;
    let todo = request.todo;
    let confirm_drop = request.confirm_drop;
    let confirm_published_rewrite = request.confirm_published_rewrite;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            "rebase",
            move |context| async move {
                let current = rebase::read_preview(task_repo_id.clone(), &path, &onto_oid)
                    .await
                    .map_err(|_| {
                        TaskFailure::Failed(
                            "Rebase preconditions could not be rechecked. Refresh repository state.".into(),
                        )
                    })?;
                if current.head_oid.as_deref() != Some(expected_head_oid.as_str())
                    || current.onto_oid != onto_oid
                    || current.preview_revision != expected_preview_revision
                    || !current.can_start
                {
                    return Err(TaskFailure::Failed(
                        "Rebase preconditions changed before Git could start. Review the current repository state.".into(),
                    ));
                }
                rebase::validate_todo(
                    &current,
                    &todo,
                    confirm_drop,
                    confirm_published_rewrite,
                )
                .map_err(|_| {
                    TaskFailure::Failed(
                        "The reviewed rebase todo is no longer valid. Review the current commit sequence.".into(),
                    )
                })?;
                let task_context = context.clone();
                let result = command
                    .execute_rebase(&path, &expected_head_oid, &onto_oid, &current, &todo, context)
                    .await;
                if result.is_ok() && repositories.refresh_metadata(&task_repo_id).await.is_err() {
                    task_context
                        .log("Repository metadata refresh failed after rebase; refresh the repository before the next write.")
                        .await;
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn list_repository_rebase_backups(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<rebase::RebaseBackupSnapshot>, ApiError> {
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    rebase::read_backup_snapshot(&target.repository_path)
        .await
        .map(Json)
        .map_err(ApiError::from_workflow_error)
}

fn is_rebase_backup_reference(reference: &str) -> bool {
    let Some(suffix) = reference.strip_prefix("refs/gitcrest/rebase-backups/") else {
        return false;
    };
    !suffix.is_empty()
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub(super) async fn rollback_repository_rebase(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RebaseRollbackRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Rebase rollback requires the reviewed HEAD and a backup reference.",
        )
    })?;
    if !request.confirm_rollback || !is_rebase_backup_reference(&request.backup_reference) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Rollback requires explicit confirmation and a GitCrest rebase backup reference.",
        ));
    }
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = rebase::read_backup_snapshot(&target.repository_path)
        .await
        .map_err(ApiError::from_workflow_error)?;
    if snapshot.head_oid.as_deref() != Some(request.expected_head_oid.as_str())
        || !snapshot.can_rollback
        || !snapshot.backups.iter().any(|backup| {
            backup.reference == request.backup_reference && backup.oid == request.backup_oid
        })
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowPreflightStale,
            "The current branch, worktree, or selected backup changed. Refresh the rollback review.",
        ));
    }
    let command = state.git_commands.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let expected_head_oid = request.expected_head_oid;
    let backup_reference = request.backup_reference;
    let backup_oid = request.backup_oid;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            "rebaseRollback",
            move |context| async move {
                let current = rebase::read_backup_snapshot(&path).await.map_err(|_| {
                    TaskFailure::Failed(
                        "Rollback preconditions could not be rechecked. Refresh repository state.".into(),
                    )
                })?;
                if current.head_oid.as_deref() != Some(expected_head_oid.as_str())
                    || !current.can_rollback
                    || !current.backups.iter().any(|backup| {
                        backup.reference == backup_reference && backup.oid == backup_oid
                    })
                {
                    return Err(TaskFailure::Failed(
                        "Rollback preconditions changed before Git could start. Review the current repository state.".into(),
                    ));
                }
                let task_context = context.clone();
                let result = command
                    .execute_rebase_rollback(
                        &path,
                        &expected_head_oid,
                        &backup_oid,
                        &backup_reference,
                        context,
                    )
                    .await;
                if result.is_ok() && repositories.refresh_metadata(&task_repo_id).await.is_err() {
                    task_context
                        .log("Repository metadata refresh failed after rollback; refresh the repository before the next write.")
                        .await;
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn preflight_repository_reset(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<ResetPreviewQuery>, QueryRejection>,
) -> Result<Json<reset::ResetPreview>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Reset preview requires a target commit and mode.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    reset::read_preview(
        repo_id,
        &target.repository_path,
        &query.target_oid,
        query.mode,
    )
    .await
    .map(Json)
    .map_err(ApiError::from_workflow_error)
}

pub(super) async fn start_repository_reset(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<ResetRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Reset requires the reviewed HEAD, target, mode, and preview revision.",
        )
    })?;
    if !request.confirm_reset {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Reset requires explicit confirmation after reviewing the affected commits and paths.",
        ));
    }
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let preview = reset::read_preview(
        repo_id.clone(),
        &target.repository_path,
        &request.target_oid,
        request.mode,
    )
    .await
    .map_err(ApiError::from_workflow_error)?;
    if preview.expected_head_oid != request.expected_head_oid
        || preview.target_oid != request.target_oid
        || preview.preview_revision != request.preview_revision
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowPreflightStale,
            "HEAD, target, or affected paths changed after review. Refresh the reset preview.",
        ));
    }
    if !preview.can_start {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowRequiresClean,
            "This reset cannot start because the target is already HEAD, a Git operation is active, or hard reset would overwrite local changes.",
        ));
    }
    let command = state.git_commands.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let expected_head_oid = request.expected_head_oid;
    let target_oid = request.target_oid;
    let mode = request.mode;
    let expected_revision = request.preview_revision;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            "reset",
            move |context| async move {
                let current = reset::read_preview(
                    task_repo_id.clone(),
                    &path,
                    &target_oid,
                    mode,
                )
                .await
                .map_err(|_| {
                    TaskFailure::Failed(
                        "Reset preconditions could not be rechecked. Refresh repository state.".into(),
                    )
                })?;
                if current.expected_head_oid != expected_head_oid
                    || current.preview_revision != expected_revision
                    || !current.can_start
                {
                    return Err(TaskFailure::Failed(
                        "Reset preconditions changed before Git could start. Review the affected commits and paths again.".into(),
                    ));
                }
                let task_context = context.clone();
                let result = command.execute_reset(&path, &current, context).await;
                if result.is_ok() && repositories.refresh_metadata(&task_repo_id).await.is_err() {
                    task_context
                        .log("Repository metadata refresh failed after reset; refresh the repository before the next write.")
                        .await;
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn list_repository_reset_backups(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<reset::ResetBackupSnapshot>, ApiError> {
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    reset::read_backup_snapshot(&target.repository_path)
        .await
        .map(Json)
        .map_err(ApiError::from_workflow_error)
}

fn is_reset_backup_reference(reference: &str) -> bool {
    let Some(suffix) = reference.strip_prefix("refs/gitcrest/reset-backups/") else {
        return false;
    };
    !suffix.is_empty()
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub(super) async fn restore_repository_reset(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<ResetRestoreRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Reset restore requires the reviewed HEAD and a reset backup reference.",
        )
    })?;
    if !request.confirm_restore || !is_reset_backup_reference(&request.backup_reference) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Restore requires explicit confirmation and a GitCrest reset backup reference.",
        ));
    }
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = reset::read_backup_snapshot(&target.repository_path)
        .await
        .map_err(ApiError::from_workflow_error)?;
    if snapshot.head_oid.as_deref() != Some(request.expected_head_oid.as_str())
        || !snapshot.can_restore
        || !snapshot.backups.iter().any(|backup| {
            backup.reference == request.backup_reference && backup.oid == request.backup_oid
        })
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowPreflightStale,
            "The current branch, worktree, or selected backup changed. Refresh the restore review.",
        ));
    }
    let command = state.git_commands.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let expected_head_oid = request.expected_head_oid;
    let backup_reference = request.backup_reference;
    let backup_oid = request.backup_oid;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            "resetRestore",
            move |context| async move {
                let current = reset::read_backup_snapshot(&path).await.map_err(|_| {
                    TaskFailure::Failed(
                        "Reset restore preconditions could not be rechecked. Refresh repository state.".into(),
                    )
                })?;
                if current.head_oid.as_deref() != Some(expected_head_oid.as_str())
                    || !current.can_restore
                    || !current.backups.iter().any(|backup| {
                        backup.reference == backup_reference && backup.oid == backup_oid
                    })
                {
                    return Err(TaskFailure::Failed(
                        "Reset restore preconditions changed before Git could start. Review repository state again.".into(),
                    ));
                }
                let task_context = context.clone();
                let result = command
                    .execute_reset_restore(
                        &path,
                        &expected_head_oid,
                        &backup_oid,
                        &backup_reference,
                        context,
                    )
                    .await;
                if result.is_ok() && repositories.refresh_metadata(&task_repo_id).await.is_err() {
                    task_context
                        .log("Repository metadata refresh failed after reset restore; refresh the repository before the next write.")
                        .await;
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
