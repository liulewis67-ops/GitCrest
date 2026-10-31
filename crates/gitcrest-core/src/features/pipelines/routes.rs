use axum::{routing::get, Router};

use crate::state::AppState;

use super::handlers::{
    get_app_settings, get_repository_settings, get_rules, put_app_settings,
    put_repository_settings, put_rules,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/settings/pipelines",
            get(get_app_settings).put(put_app_settings),
        )
        .route(
            "/v1/repositories/:repo_id/pipelines/settings",
            get(get_repository_settings).put(put_repository_settings),
        )
        .route(
            "/v1/repositories/:repo_id/pipelines/rules",
            get(get_rules).put(put_rules),
        )
}
