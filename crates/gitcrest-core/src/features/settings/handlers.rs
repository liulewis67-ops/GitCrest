use axum::{
    extract::{rejection::JsonRejection, State},
    http::StatusCode,
    Json,
};

use super::service as ai;
use crate::{
    api::error::{ApiError, ApiErrorCode},
    credentials,
    state::AppState,
};
fn ai_provider_name(provider: ai::AiProvider) -> &'static str {
    match provider {
        ai::AiProvider::None => "none",
        ai::AiProvider::OpenAiCompatible => "openAiCompatible",
        ai::AiProvider::Ollama => "ollama",
    }
}

fn ai_settings_from_parts(
    provider: &str,
    base_url: String,
    model: String,
    has_cloud_credential: bool,
) -> Result<ai::AiSettings, ApiError> {
    let provider = match provider {
        "none" => ai::AiProvider::None,
        "openAiCompatible" => ai::AiProvider::OpenAiCompatible,
        "ollama" => ai::AiProvider::Ollama,
        _ => {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "AI provider settings could not be read.",
            ))
        }
    };
    Ok(ai::AiSettings {
        provider,
        base_url,
        model,
        has_cloud_credential,
    })
}

pub(crate) async fn get_ai_settings(
    State(state): State<AppState>,
) -> Result<Json<ai::AiSettings>, ApiError> {
    let store = state.repositories.store();
    let manager = state.ai_credentials.clone();
    let settings = tokio::task::spawn_blocking(move || {
        let (provider, base_url, model) = store.ai_provider_settings().map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::DatabaseUnavailable,
                "AI provider settings are unavailable.",
            )
        })?;
        let has_credential = manager
            .is_configured()
            .map_err(ApiError::from_credential_error)?;
        ai_settings_from_parts(&provider, base_url, model, has_credential)
    })
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::DatabaseUnavailable,
            "AI provider settings are unavailable.",
        )
    })??;
    Ok(Json(settings))
}

pub(super) async fn set_ai_settings(
    State(state): State<AppState>,
    request: Result<Json<ai::AiSettingsRequest>, JsonRejection>,
) -> Result<Json<ai::AiSettings>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Valid AI provider settings are required.",
        )
    })?;
    ai::validate_settings(&request).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The AI provider endpoint or model is invalid for the selected provider.",
        )
    })?;
    let store = state.repositories.store();
    let provider = ai_provider_name(request.provider).to_owned();
    let base_url = request.base_url;
    let model = request.model;
    let manager = state.ai_credentials.clone();
    let settings = tokio::task::spawn_blocking(move || {
        store
            .set_ai_provider_settings(&provider, &base_url, &model)
            .map_err(|_| {
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    ApiErrorCode::DatabaseUnavailable,
                    "AI provider settings could not be saved.",
                )
            })?;
        let has_credential = manager
            .is_configured()
            .map_err(ApiError::from_credential_error)?;
        ai_settings_from_parts(&provider, base_url, model, has_credential)
    })
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::DatabaseUnavailable,
            "AI provider settings could not be saved.",
        )
    })??;
    Ok(Json(settings))
}

pub(super) async fn set_ai_credential(
    State(state): State<AppState>,
    request: Result<Json<ai::AiCredentialRequest>, JsonRejection>,
) -> Result<Json<ai::AiSettings>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A non-empty API key is required.",
        )
    })?;
    let store = state.repositories.store();
    let manager = state.ai_credentials.clone();
    let settings = tokio::task::spawn_blocking(move || {
        let (provider, base_url, model) = store.ai_provider_settings().map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::DatabaseUnavailable,
                "AI provider settings are unavailable.",
            )
        })?;
        if provider != "openAiCompatible" {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::RequestInvalid,
                "Select the OpenAI-compatible provider before saving an API key.",
            ));
        }
        manager
            .set(&request.api_key)
            .map_err(ApiError::from_credential_error)?;
        ai_settings_from_parts(&provider, base_url, model, true)
    })
    .await
    .map_err(|_| ApiError::from_credential_error(credentials::CredentialError::Unavailable))??;
    Ok(Json(settings))
}

pub(super) async fn delete_ai_credential(
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    let manager = state.ai_credentials.clone();
    tokio::task::spawn_blocking(move || manager.delete())
        .await
        .map_err(|_| ApiError::from_credential_error(credentials::CredentialError::Unavailable))?
        .map_err(ApiError::from_credential_error)?;
    Ok(StatusCode::NO_CONTENT)
}
