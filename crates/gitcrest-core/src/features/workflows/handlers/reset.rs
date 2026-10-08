use axum::{
    extract::{rejection::JsonRejection, rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use super::super::dto::{
    ResetBackupSnapshotDto, ResetPreviewDto, ResetPreviewQuery, ResetRequest, ResetRestoreRequest,
};
use super::super::reset;
use crate::{
    api::error::{ApiError, ApiErrorCode},
    features::tasks::{TaskFailure, TaskSnapshot},
    state::AppState,
};

pub(in crate::features::workflows) async fn preflight_repository_reset(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<ResetPreviewQuery>, QueryRejection>,
) -> Result<Json<ResetPreviewDto>, ApiError> {
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
        &state.git_commands,
        repo_id,
        &target.repository_path,
        &query.target_oid,
        query.mode,
    )
    .await
    .map(ResetPreviewDto::from)
    .map(Json)
    .map_err(ApiError::from_workflow_error)
}

pub(in crate::features::workflows) async fn start_repository_reset(
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
        &state.git_commands,
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
                    &command,
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
                let result = command
                    .execute_reset(
                        &path,
                        &current.expected_head_oid,
                        &current.target_oid,
                        current.mode.git_argument(),
                        context,
                    )
                    .await;
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

pub(in crate::features::workflows) async fn list_repository_reset_backups(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<ResetBackupSnapshotDto>, ApiError> {
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    reset::read_backup_snapshot(&state.git_commands, &target.repository_path)
        .await
        .map(ResetBackupSnapshotDto::from)
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

pub(in crate::features::workflows) async fn restore_repository_reset(
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
    let snapshot = reset::read_backup_snapshot(&state.git_commands, &target.repository_path)
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
                let current = reset::read_backup_snapshot(&command, &path).await.map_err(|_| {
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
