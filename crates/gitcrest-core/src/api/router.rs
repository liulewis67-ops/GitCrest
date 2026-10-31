use axum::{
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderName, HeaderValue, Method,
    },
    middleware,
    routing::get,
    Router,
};
use tower_http::cors::CorsLayer;

use super::{
    error::ApiError,
    middleware::{
        auth::require_auth,
        version::{add_api_version_header, require_api_version},
    },
};

#[cfg(test)]
use crate::write_probe;

use crate::{
    features::{
        accounts, branches, commits, compare, credentials, diff, history, identity, ignore, reflog,
        remotes, repositories, settings, shelves, signing, staging, stash, status, system, tags,
        tasks, workflows,
    },
    AppState,
};

async fn api_not_found() -> ApiError {
    ApiError::route_not_found()
}

pub(crate) fn app_router(state: AppState, cors_origin: Option<HeaderValue>) -> Router {
    let api = system::routes::api_router()
        .merge(repositories::routes::router())
        .merge(status::routes::router())
        .merge(diff::routes::router())
        .merge(history::routes::router())
        .merge(branches::routes::router())
        .merge(remotes::routes::router())
        .merge(staging::routes::router())
        .merge(shelves::routes::router())
        .merge(credentials::routes::router())
        .merge(accounts::routes::router())
        .merge(settings::routes::router())
        .merge(commits::routes::router())
        .merge(tags::routes::router())
        .merge(identity::routes::router())
        .merge(stash::routes::router())
        .merge(ignore::routes::router())
        .merge(reflog::routes::router())
        .merge(compare::routes::router())
        .merge(signing::routes::router())
        .merge(tasks::routes::router())
        .merge(workflows::routes::router())
        .route("/v1/events", get(crate::events::routes::events))
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
                ])
                // The renderer checks this header on every versioned response.
                .expose_headers([HeaderName::from_static("x-gitcrest-api-version")]),
        )
    } else {
        api
    };
    let api = api.layer(middleware::from_fn(add_api_version_header));

    system::routes::health_router()
        .nest("/api", api)
        .with_state(state)
}
