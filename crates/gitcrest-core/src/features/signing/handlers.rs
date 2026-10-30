use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    state::AppState,
};

use super::{
    dto::{SigningConfig, SigningTestResult},
    service::{self, SigningError},
};

fn api_error(error: SigningError) -> ApiError {
    match error {
        SigningError::GitUnavailable => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::GitUnavailable,
            "Git could not be started. Install Git or check that it is on PATH.",
        ),
        SigningError::Failed => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::HistoryUnavailable,
            "Git could not read or test the signing setup.",
        ),
    }
}

pub(super) async fn repository_signing(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<SigningConfig>, ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    service::read_config(&target.repository_path, repo_id)
        .await
        .map(Json)
        .map_err(api_error)
}

pub(super) async fn test_repository_signing(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<SigningTestResult>, ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let (signed, output) = service::test_signing(&target.repository_path)
        .await
        .map_err(api_error)?;
    Ok(Json(SigningTestResult {
        repo_id,
        signed,
        output,
    }))
}
