use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};

use super::{
    dto::{DeviceFlowRequest, DeviceFlowResponse, TokenSignInRequest},
    service::{is_valid_flow_id, AccountError, AccountList, AccountSummary},
};
use crate::{
    api::error::{ApiError, ApiErrorCode},
    credentials::is_valid_account_id,
    state::AppState,
};

fn flow_id(value: String) -> Result<String, ApiError> {
    if is_valid_flow_id(&value) {
        Ok(value)
    } else {
        Err(ApiError::from_account_error(AccountError::FlowNotFound))
    }
}

fn account_id(value: String) -> Result<String, ApiError> {
    if is_valid_account_id(&value) {
        Ok(value)
    } else {
        Err(ApiError::from_account_error(AccountError::NotFound))
    }
}

pub(super) async fn list_accounts(
    State(state): State<AppState>,
) -> Result<Json<AccountList>, ApiError> {
    state
        .accounts
        .list()
        .await
        .map(Json)
        .map_err(ApiError::from_account_error)
}

pub(super) async fn sign_in_with_token(
    State(state): State<AppState>,
    request: Result<Json<TokenSignInRequest>, JsonRejection>,
) -> Result<Json<AccountSummary>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::AccountInputInvalid,
            "A provider, host and access token are required.",
        )
    })?;
    state
        .accounts
        .sign_in_with_token(request.provider, &request.host, request.token.as_str())
        .await
        .map(Json)
        .map_err(ApiError::from_account_error)
}

pub(super) async fn start_device_flow(
    State(state): State<AppState>,
    request: Result<Json<DeviceFlowRequest>, JsonRejection>,
) -> Result<Json<DeviceFlowResponse>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::AccountInputInvalid,
            "A provider and host are required.",
        )
    })?;
    state
        .accounts
        .start_device_flow(request.provider, &request.host)
        .await
        .map(|flow| Json(DeviceFlowResponse::from(flow)))
        .map_err(ApiError::from_account_error)
}

pub(super) async fn get_device_flow(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<DeviceFlowResponse>, ApiError> {
    state
        .accounts
        .device_flow(&flow_id(id)?)
        .map(|flow| Json(DeviceFlowResponse::from(flow)))
        .map_err(ApiError::from_account_error)
}

pub(super) async fn cancel_device_flow(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .accounts
        .cancel_device_flow(&flow_id(id)?)
        .map_err(ApiError::from_account_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn select_account(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<AccountSummary>, ApiError> {
    state
        .accounts
        .select(&account_id(id)?)
        .await
        .map(Json)
        .map_err(ApiError::from_account_error)
}

pub(super) async fn validate_account(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<AccountSummary>, ApiError> {
    state
        .accounts
        .validate(&account_id(id)?)
        .await
        .map(Json)
        .map_err(ApiError::from_account_error)
}

pub(super) async fn sign_out(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state
        .accounts
        .sign_out(&account_id(id)?)
        .await
        .map_err(ApiError::from_account_error)?;
    Ok(StatusCode::NO_CONTENT)
}
