use axum::{
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderName, HeaderValue, Method,
    },
    middleware,
    routing::{get, post},
    Router,
};
use tower_http::cors::CorsLayer;

#[cfg(test)]
use crate::write_probe;

use crate::{
    add_api_version_header, api_not_found, commit_repository, get_workflow_conflict_ai_settings,
    list_repository_rebase_backups, list_repository_reset_backups, mark_workflow_conflict_resolved,
    preflight_repository_rebase, preflight_repository_reset, preflight_repository_workflow,
    preflight_repository_workflow_recovery, read_workflow_conflict_file,
    recover_repository_workflow, repositories, request_ai, request_workflow_conflict_suggestion,
    require_api_version, require_auth, restore_repository_reset, rollback_repository_rebase,
    save_workflow_conflict_file, start_repository_rebase, start_repository_reset,
    start_repository_workflow, status, system, AppState,
};

pub(crate) fn app_router(state: AppState, cors_origin: Option<HeaderValue>) -> Router {
    let api = system::routes::api_router()
        .merge(repositories::routes::router())
        .merge(status::routes::router())
        .merge(crate::diff::routes::router())
        .merge(crate::history::routes::router())
        .merge(crate::branches::routes::router())
        .merge(crate::remotes::routes::router())
        .merge(crate::staging::routes::router())
        .merge(crate::shelves::routes::router())
        .merge(crate::credentials::routes::router())
        .merge(crate::settings::routes::router())
        .merge(crate::tags::routes::router())
        .merge(crate::tasks::routes::router())
        .route("/v1/repositories/:repo_id/ai/request", post(request_ai))
        .route(
            "/v1/repositories/:repo_id/commits",
            crate::history::routes::commits_get_route().post(commit_repository),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/preflight",
            get(preflight_repository_workflow),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/rebase-preview",
            get(preflight_repository_rebase).post(start_repository_rebase),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/rebase-backups",
            get(list_repository_rebase_backups),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/rebase-rollback",
            post(rollback_repository_rebase),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/reset-preview",
            get(preflight_repository_reset).post(start_repository_reset),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/reset-backups",
            get(list_repository_reset_backups),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/reset-restore",
            post(restore_repository_reset),
        )
        .route(
            "/v1/repositories/:repo_id/workflows",
            post(start_repository_workflow),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/recovery-preflight",
            get(preflight_repository_workflow_recovery),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/recovery",
            post(recover_repository_workflow),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/conflicts/file",
            get(read_workflow_conflict_file).put(save_workflow_conflict_file),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/conflicts/resolved",
            post(mark_workflow_conflict_resolved),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/conflicts/suggestion",
            post(request_workflow_conflict_suggestion),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/conflicts/ai-settings",
            get(get_workflow_conflict_ai_settings),
        )
        .route("/v1/events", get(crate::api::events::events))
        .fallback(api_not_found);

    #[cfg(test)]
    let api = api.route("/v1/test/write-probe", axum::routing::post(write_probe));

    let api = api
        .layer(middleware::from_fn(require_api_version))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth));

    let api = if let Some(origin) = cors_origin {
        api.layer(
            CorsLayer::new()
                .allow_origin(origin)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([
                    AUTHORIZATION,
                    CONTENT_TYPE,
                    HeaderName::from_static("x-gitcrest-api-version"),
                ]),
        )
    } else {
        api
    };
    let api = api.layer(middleware::from_fn(add_api_version_header));

    system::routes::health_router()
        .nest("/api", api)
        .with_state(state)
}
