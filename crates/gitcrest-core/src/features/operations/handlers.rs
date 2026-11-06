use super::{dto::OperationRecoveryResponse, query::OperationQueryError};
use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::request_access::RequestAccess,
    ports::operations::OperationStoreError,
    state::AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ByRequest {
    request_id: String,
}

fn valid_id(value: &str) -> Result<(), ApiError> {
    if value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A nonempty repository, operation or request identity of at most 128 UTF-8 bytes is required.",
        ))
    } else {
        Ok(())
    }
}
fn query_error(error: OperationQueryError) -> ApiError {
    match error {
        OperationQueryError::Forbidden => ApiError::forbidden(),
        OperationQueryError::Store(OperationStoreError::NotFound) => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::OperationNotFound,
            "The operation was not found in this repository.",
        ),
        OperationQueryError::Store(_) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::DatabaseUnavailable,
            "The durable operation snapshot could not be read.",
        ),
    }
}
fn malformed_path(_: axum::extract::rejection::PathRejection) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        ApiErrorCode::RequestInvalid,
        "The repository or operation identity is malformed.",
    )
}
pub(super) async fn by_id(
    State(state): State<AppState>,
    Extension(access): Extension<RequestAccess>,
    path: Result<Path<(String, String)>, axum::extract::rejection::PathRejection>,
) -> Result<Json<OperationRecoveryResponse>, ApiError> {
    let Path((repo, id)) = path.map_err(malformed_path)?;
    valid_id(&repo)?;
    valid_id(&id)?;
    state
        .operation_queries
        .get(access, &repo, &id)
        .await
        .map(|v| Json(v.into()))
        .map_err(query_error)
}
pub(super) async fn by_request(
    State(state): State<AppState>,
    Extension(access): Extension<RequestAccess>,
    path: Result<Path<String>, axum::extract::rejection::PathRejection>,
    query: Result<Query<ByRequest>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<OperationRecoveryResponse>, ApiError> {
    let Path(repo) = path.map_err(malformed_path)?;
    valid_id(&repo)?;
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The original requestId query parameter is required.",
        )
    })?;
    valid_id(&query.request_id)?;
    state
        .operation_queries
        .get_by_request(access, &repo, &query.request_id)
        .await
        .map(|v| Json(v.into()))
        .map_err(query_error)
}
