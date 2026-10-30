use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

use super::handlers::{repository_signing, test_repository_signing};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/repositories/:repo_id/signing", get(repository_signing))
        .route(
            "/v1/repositories/:repo_id/signing/test",
            post(test_repository_signing),
        )
}
