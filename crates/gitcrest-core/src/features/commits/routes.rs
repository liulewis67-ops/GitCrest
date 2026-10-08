use axum::Router;

use crate::state::AppState;

use super::handlers::commit_repository;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/repositories/:repo_id/commits",
        crate::history::routes::commits_get_route().post(commit_repository),
    )
}
