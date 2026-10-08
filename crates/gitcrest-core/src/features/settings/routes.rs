use axum::{routing::get, Router};

use crate::{
    delete_ai_credential, get_ai_settings, set_ai_credential, set_ai_settings, state::AppState,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/ai/settings", get(get_ai_settings).put(set_ai_settings))
        .route(
            "/v1/ai/credential",
            axum::routing::put(set_ai_credential).delete(delete_ai_credential),
        )
}
