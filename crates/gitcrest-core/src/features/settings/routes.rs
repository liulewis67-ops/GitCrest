use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

use super::handlers::{get_ai_settings, request_ai, set_ai_settings, test_ai_provider};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/ai/settings", get(get_ai_settings).put(set_ai_settings))
        .route("/v1/ai/providers/test", post(test_ai_provider))
        .route("/v1/repositories/:repo_id/ai/request", post(request_ai))
}
