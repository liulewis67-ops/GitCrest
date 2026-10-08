use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

use super::handlers::{
    delete_ai_credential, get_ai_settings, request_ai, set_ai_credential, set_ai_settings,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/ai/settings", get(get_ai_settings).put(set_ai_settings))
        .route(
            "/v1/ai/credential",
            axum::routing::put(set_ai_credential).delete(delete_ai_credential),
        )
        .route("/v1/repositories/:repo_id/ai/request", post(request_ai))
}
