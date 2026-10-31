use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    state::AppState,
    TaskSnapshot,
};

use super::{
    dto::{SubmoduleList, SubmoduleUpdateRequest},
    service::{self, SubmoduleError},
};

fn api_error(error: SubmoduleError) -> ApiError {
    match error {
        SubmoduleError::UnknownPath => ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A path in the request is not a submodule of this repository.",
        ),
        SubmoduleError::GitUnavailable => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::GitUnavailable,
            "Git could not be started. Install Git or check that it is on PATH.",
        ),
        SubmoduleError::Failed => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::HistoryUnavailable,
            "Git could not read the submodules.",
        ),
    }
}

pub(super) async fn list_repository_submodules(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<SubmoduleList>, ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let items = service::list(&target.repository_path)
        .await
        .map_err(api_error)?;
    Ok(Json(SubmoduleList { repo_id, items }))
}

pub(super) async fn update_repository_submodules(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<SubmoduleUpdateRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The submodule update request is invalid.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let known = service::list(&target.repository_path)
        .await
        .map_err(api_error)?;
    // Only paths the repository itself declares reach Git, so a request cannot name anything else.
    if request
        .paths
        .iter()
        .any(|path| !known.iter().any(|entry| &entry.path == path))
    {
        return Err(api_error(SubmoduleError::UnknownPath));
    }
    let paths: Vec<String> = if request.paths.is_empty() {
        known
            .iter()
            .filter(|entry| request.init || entry.checked_out_oid.is_some())
            .map(|entry| entry.path.clone())
            .collect()
    } else {
        request.paths
    };
    if paths.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "There is no submodule to update.",
        ));
    }
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    if metadata.state != "normal" {
        return Err(ApiError::state_conflict(
            "Finish the running merge, rebase or similar operation before updating submodules.",
        ));
    }
    let path = target.repository_path;
    let commands = state.git_commands.clone();
    let init = request.init;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "submoduleUpdate",
            move |context| async move {
                commands
                    .execute_submodule_update(&path, &paths, init, context)
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
