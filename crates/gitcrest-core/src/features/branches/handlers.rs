use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    branches, AppState, RepositoryError,
};

use super::dto::BranchFavoriteRequest;

pub(super) async fn repository_branches(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<branches::BranchSnapshot>, ApiError> {
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let mut snapshot = branches::read_branches(
        repo_id,
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    let store = state.repositories.store();
    let favorite_repo_id = snapshot.repo_id.clone();
    let favorites = tokio::task::spawn_blocking(move || store.branch_favorites(&favorite_repo_id))
        .await
        .map_err(|_| ApiError::from_repository_error(RepositoryError::StorageUnavailable))?
        .map_err(|_| ApiError::from_repository_error(RepositoryError::StorageUnavailable))?;
    for branch in &mut snapshot.branches {
        branch.is_favorite = favorites
            .iter()
            .any(|full_name| full_name == &branch.full_name);
    }
    Ok(Json(snapshot))
}

pub(super) async fn set_branch_favorite(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<BranchFavoriteRequest>, JsonRejection>,
) -> Result<Json<branches::BranchSnapshot>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A branch ref and favorite state are required.",
        )
    })?;
    let mut snapshot = repository_branches(State(state.clone()), Path(repo_id.clone()))
        .await?
        .0;
    let Some(branch) = snapshot
        .branches
        .iter_mut()
        .find(|branch| branch.full_name == request.full_name)
    else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::BranchNotFound,
            "The branch ref does not exist.",
        ));
    };
    let store = state.repositories.store();
    let full_name = request.full_name;
    let favorite = request.favorite;
    let storage_repo_id = repo_id;
    tokio::task::spawn_blocking(move || {
        store.set_branch_favorite(&storage_repo_id, &full_name, favorite)
    })
    .await
    .map_err(|_| ApiError::from_repository_error(RepositoryError::StorageUnavailable))?
    .map_err(|_| ApiError::from_repository_error(RepositoryError::StorageUnavailable))?;
    branch.is_favorite = favorite;
    Ok(Json(snapshot))
}
