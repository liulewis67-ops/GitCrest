use axum::{routing::get, Router};

use crate::state::AppState;

use super::handlers::list_repository_stashes;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/repositories/:repo_id/stashes",
        get(list_repository_stashes),
    )
}
