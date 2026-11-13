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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ActiveQuery {
    active: bool,
}

pub(super) async fn list_active(
    State(state): State<AppState>,
    Extension(access): Extension<RequestAccess>,
    path: Result<Path<String>, axum::extract::rejection::PathRejection>,
    query: Result<Query<ActiveQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Vec<OperationRecoveryResponse>>, ApiError> {
    let Path(repo) = path.map_err(malformed_path)?;
    valid_id(&repo)?;
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The active=true query parameter is required.",
        )
    })?;
    if !query.active {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Only active=true operation listing is available.",
        ));
    }
    state
        .operation_queries
        .list_active(access, &repo)
        .await
        .map(|views| Json(views.into_iter().map(Into::into).collect()))
        .map_err(|error| match error {
            OperationQueryError::Store(OperationStoreError::NotFound) => {
                ApiError::repository_not_found()
            }
            other => query_error(other),
        })
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ActionBody {
    request_id: String,
    kind: crate::domain::operation_action::OperationActionKind,
    expected_version: String,
}

pub(super) async fn submit_action(
    State(state): State<AppState>,
    Extension(access): Extension<RequestAccess>,
    path: Result<Path<(String, String)>, axum::extract::rejection::PathRejection>,
    body: Result<Json<ActionBody>, axum::extract::rejection::JsonRejection>,
) -> Result<(StatusCode, Json<super::dto::ActionSubmissionResponse>), ApiError> {
    use crate::features::operations::actions::ActionSubmitError;
    let Path((repo, id)) = path.map_err(malformed_path)?;
    valid_id(&repo)?;
    valid_id(&id)?;
    let Json(body) = body.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A requestId, a known action kind and a decimal expectedVersion are required.",
        )
    })?;
    valid_id(&body.request_id)?;
    let expected_version = body
        .expected_version
        .parse::<i64>()
        .ok()
        .filter(|version| *version >= 1 && version.to_string() == body.expected_version)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "expectedVersion must be a positive decimal integer string.",
            )
        })?;
    let request = crate::domain::operation_action::OperationActionRequest {
        request_id: body.request_id,
        expected_version,
        kind: body.kind,
    };
    state
        .operation_actions
        .submit(&state.tasks, access, &repo, &id, request)
        .await
        .map(|submission| {
            (
                StatusCode::ACCEPTED,
                Json(super::dto::ActionSubmissionResponse::new(submission)),
            )
        })
        .map_err(|error| match error {
            ActionSubmitError::Forbidden => ApiError::forbidden(),
            ActionSubmitError::Task(error) => ApiError::task_submit(error),
            ActionSubmitError::Store(error) => match error {
                OperationStoreError::NotFound => query_error(OperationQueryError::Store(error)),
                OperationStoreError::VersionConflict => ApiError::new(
                    StatusCode::CONFLICT,
                    ApiErrorCode::ResourceVersionStale,
                    "The operation changed since it was read. Reload its current state.",
                ),
                OperationStoreError::ResourceOwned { operation_id } => {
                    ApiError::task_submit(crate::execution::TaskSubmitError::OperationActive {
                        operation_id,
                    })
                }
                OperationStoreError::Unavailable => query_error(OperationQueryError::Store(error)),
                OperationStoreError::RequestConflict
                | OperationStoreError::InvalidTransition
                | OperationStoreError::InvalidBackup
                | OperationStoreError::TooManyActive => ApiError::new(
                    StatusCode::CONFLICT,
                    ApiErrorCode::RepositoryStateConflict,
                    "This action is not available for the operation's current state or request identity.",
                ),
            },
        })
}
