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

use crate::{repositories, status, system, AppState};

async fn api_not_found() -> ApiError {
    ApiError::route_not_found()
}

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
        .merge(crate::commits::routes::router())
        .merge(crate::features::tags::routes::router())
        .merge(crate::tasks::routes::router())
        .merge(crate::workflows::routes::router())
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
