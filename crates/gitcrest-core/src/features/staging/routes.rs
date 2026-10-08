use axum::{routing::post, Router};

use crate::{
    discard_repository_patch, stage_repository, stage_repository_patch, state::AppState,
    undo_recent_operation,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/repositories/:repo_id/staging", post(stage_repository))
        .route(
            "/v1/repositories/:repo_id/undo",
            post(undo_recent_operation),
        )
        .route(
            "/v1/repositories/:repo_id/staging/patch",
            post(stage_repository_patch),
        )
        .route(
            "/v1/repositories/:repo_id/staging/discard",
            post(discard_repository_patch),
        )
}
