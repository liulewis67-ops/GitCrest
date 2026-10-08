use axum::{
    extract::{rejection::JsonRejection, rejection::QueryRejection, Query, State},
    http::StatusCode,
    Json,
};

use super::dto::{CredentialHostQuery, SetCredentialRequest};
use crate::{
    api::error::{ApiError, ApiErrorCode},
    features::credentials,
    state::AppState,
};

pub(super) async fn get_credential_status(
    State(state): State<AppState>,
    query: Result<Query<CredentialHostQuery>, QueryRejection>,
) -> Result<Json<credentials::CredentialStatus>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::CredentialInputInvalid,
            "A valid HTTPS credential host is required.",
        )
    })?;
    let manager = state.credentials.clone();
    let status = tokio::task::spawn_blocking(move || manager.status(&query.host))
        .await
        .map_err(|_| ApiError::from_credential_error(credentials::CredentialError::Unavailable))?
        .map_err(ApiError::from_credential_error)?;
    Ok(Json(status))
}

pub(super) async fn set_credential(
    State(state): State<AppState>,
    request: Result<Json<SetCredentialRequest>, JsonRejection>,
) -> Result<Json<credentials::CredentialStatus>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::CredentialInputInvalid,
            "A host, username and token are required.",
        )
    })?;
    let manager = state.credentials.clone();
    let status = tokio::task::spawn_blocking(move || {
        manager.set(&request.host, &request.username, request.token.as_str())
    })
    .await
    .map_err(|_| ApiError::from_credential_error(credentials::CredentialError::Unavailable))?
    .map_err(ApiError::from_credential_error)?;
    Ok(Json(status))
}

pub(super) async fn delete_credential(
    State(state): State<AppState>,
    query: Result<Query<CredentialHostQuery>, QueryRejection>,
) -> Result<StatusCode, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::CredentialInputInvalid,
            "A valid HTTPS credential host is required.",
        )
    })?;
    let manager = state.credentials.clone();
    tokio::task::spawn_blocking(move || manager.delete(&query.host))
        .await
        .map_err(|_| ApiError::from_credential_error(credentials::CredentialError::Unavailable))?
        .map_err(ApiError::from_credential_error)?;
    Ok(StatusCode::NO_CONTENT)
}
