use axum::{
    extract::{rejection::JsonRejection, rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    remotes, AppState, TaskFailure, TaskSnapshot,
};

use super::dto::{RemoteBranchDeleteQuery, RemoteBranchDeleteRequest};

pub(super) async fn preview_repository_remote_branch_delete(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<RemoteBranchDeleteQuery>, QueryRejection>,
) -> Result<Json<remotes::RemoteBranchDeletePreview>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A configured remote and remote branch are required.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    remotes::read_remote_branch_delete_preview(
        repo_id,
        &target.repository_path,
        &query.remote_name,
        &query.remote_branch,
    )
    .await
    .map(Json)
    .map_err(ApiError::from_remote_error)
}

pub(super) async fn delete_repository_remote_branch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RemoteBranchDeleteRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Remote branch deletion requires the reviewed branch, target OID, and preview revision.",
        )
    })?;
    if !request.confirm_delete {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Deleting a remote branch requires explicit confirmation after reviewing its impact.",
        ));
    }
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let preview = remotes::read_remote_branch_delete_preview(
        repo_id.clone(),
        &target.repository_path,
        &request.remote_name,
        &request.remote_branch,
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    if preview.expected_remote_oid != request.expected_remote_oid
        || preview.preview_revision != request.preview_revision
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowPreflightStale,
            "The remote-tracking OID or affected paths changed after review. Refresh the preview.",
        ));
    }
    if !preview.can_delete {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowNoActiveOperation,
            "Finish the active Git operation before deleting a remote branch.",
        ));
    }
    let command = state.git_commands.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let remote_name = request.remote_name;
    let remote_branch = request.remote_branch;
    let expected_remote_oid = request.expected_remote_oid;
    let expected_revision = request.preview_revision;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            "remoteBranchDelete",
            move |context| async move {
                let current = remotes::read_remote_branch_delete_preview(
                    task_repo_id.clone(),
                    &path,
                    &remote_name,
                    &remote_branch,
                )
                .await
                .map_err(|_| {
                    TaskFailure::Failed(
                        "Remote branch deletion preconditions could not be rechecked. Refresh the branch preview.".into(),
                    )
                })?;
                if current.expected_remote_oid != expected_remote_oid
                    || current.preview_revision != expected_revision
                    || !current.can_delete
                {
                    return Err(TaskFailure::Failed(
                        "The reviewed remote branch or affected path set changed. Review it again before deleting.".into(),
                    ));
                }
                let task_context = context.clone();
                let result = command
                    .execute_remote_branch_delete(&path, &current, context)
                    .await;
                if result.is_ok() && repositories.refresh_metadata(&task_repo_id).await.is_err() {
                    task_context
                        .log("Repository metadata refresh failed after remote branch deletion; refresh repository state.")
                        .await;
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
