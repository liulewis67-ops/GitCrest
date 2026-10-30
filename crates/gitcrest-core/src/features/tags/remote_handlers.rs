use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    state::AppState,
    TaskSnapshot,
};

use super::{
    dto::{
        DeleteRemoteTagBody, DeleteTagBody, DeletedTag, PushTagBody, RemoteTagPreview,
        RemoteTagQuery,
    },
    management,
    service::TagError,
};

fn remote_unreachable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        ApiErrorCode::RemotesUnavailable,
        "Git could not read the tag from the remote. Check the connection and sign-in, then retry.",
    )
}

fn invalid_tag_request() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        ApiErrorCode::RequestInvalid,
        "A valid tag name, remote and commit ID are required.",
    )
}

async fn require_remote(
    repository_path: &std::path::Path,
    remote_name: &str,
) -> Result<(), ApiError> {
    management::validate_remote_name(remote_name).map_err(ApiError::from_tag_error)?;
    if management::remote_exists(repository_path, remote_name)
        .await
        .map_err(ApiError::from_tag_error)?
    {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::RemoteNotFound,
            "The remote does not exist in this repository.",
        ))
    }
}

pub(crate) async fn delete_repository_tag(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<DeleteTagBody>, JsonRejection>,
) -> Result<Json<DeletedTag>, ApiError> {
    let Json(request) = request.map_err(|_| invalid_tag_request())?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    management::delete_local(
        &target.repository_path,
        &request.name,
        &request.expected_target_oid,
    )
    .await
    .map_err(ApiError::from_tag_error)?;
    Ok(Json(DeletedTag {
        repo_id,
        name: request.name,
    }))
}

pub(crate) async fn preview_remote_tag(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<RemoteTagQuery>, QueryRejection>,
) -> Result<Json<RemoteTagPreview>, ApiError> {
    let Query(query) = query.map_err(|_| invalid_tag_request())?;
    management::validate_tag_name(&query.name).map_err(ApiError::from_tag_error)?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    require_remote(&target.repository_path, &query.remote_name).await?;
    let remote_oid = state
        .git_commands
        .read_remote_tag(&target.repository_path, &query.remote_name, &query.name)
        .await
        .map_err(|_| remote_unreachable())?;
    let local_oid = management::local_tag_object(&target.repository_path, &query.name)
        .await
        .map_err(ApiError::from_tag_error)?;
    let same_as_local = remote_oid.is_some() && remote_oid == local_oid;
    Ok(Json(RemoteTagPreview {
        repo_id,
        remote_name: query.remote_name,
        name: query.name,
        remote_oid,
        local_oid,
        same_as_local,
    }))
}

pub(crate) async fn push_repository_tag(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<PushTagBody>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| invalid_tag_request())?;
    management::validate_tag_name(&request.name).map_err(ApiError::from_tag_error)?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    require_remote(&target.repository_path, &request.remote_name).await?;
    let local_oid = management::local_tag_object(&target.repository_path, &request.name)
        .await
        .map_err(ApiError::from_tag_error)?
        .ok_or_else(|| ApiError::from_tag_error(TagError::NotFound))?;
    let remote_oid = state
        .git_commands
        .read_remote_tag(&target.repository_path, &request.remote_name, &request.name)
        .await
        .map_err(|_| remote_unreachable())?;
    // No force: a remote tag with another target is refused here and by Git itself.
    if remote_oid.as_deref().is_some_and(|oid| oid != local_oid) {
        return Err(ApiError::from_tag_error(TagError::RemoteDiffers));
    }
    let path = target.repository_path;
    let commands = state.git_commands.clone();
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "pushTag",
            move |context| async move {
                commands
                    .execute_tag_push(&path, &request.remote_name, &request.name, context)
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(crate) async fn delete_remote_tag(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<DeleteRemoteTagBody>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| invalid_tag_request())?;
    management::validate_tag_name(&request.name).map_err(ApiError::from_tag_error)?;
    management::validate_oid(&request.expected_remote_oid).map_err(ApiError::from_tag_error)?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    require_remote(&target.repository_path, &request.remote_name).await?;
    let path = target.repository_path;
    let commands = state.git_commands.clone();
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "deleteRemoteTag",
            move |context| async move {
                commands
                    .execute_remote_tag_delete(
                        &path,
                        &request.remote_name,
                        &request.name,
                        &request.expected_remote_oid,
                        context,
                    )
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
