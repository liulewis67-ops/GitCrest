use crate::{
    api::error::ApiError,
    execution::{write_access::WriteAccessError, TaskSubmitError},
    state::AppState,
};
use axum::{
    body::Body,
    extract::{MatchedPath, Path, State},
    http::{Method, Request},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::collections::HashMap;

fn access_error(error: WriteAccessError) -> ApiError {
    match error {
        WriteAccessError::Repository(error) => ApiError::from_repository_error(error),
        WriteAccessError::Unavailable => ApiError::task_submit(TaskSubmitError::StorageUnavailable),
        WriteAccessError::Owned { operation_id } => {
            ApiError::task_submit(TaskSubmitError::OperationActive { operation_id })
        }
    }
}

fn is_direct_write(method: &Method, route: &str) -> bool {
    let route = route.strip_prefix("/api").unwrap_or(route);
    let suffix = route
        .strip_prefix("/v1/repositories/:repo_id/")
        .unwrap_or("");
    matches!(
        (method, suffix),
        (&Method::PUT | &Method::DELETE, "identity")
            | (
                &Method::POST,
                "ignore" | "signing/test" | "pipelines/rules/export" | "commits/:oid/tags"
            )
    ) || *method == Method::DELETE && suffix == "shelves/:shelf_id"
}

pub(crate) async fn require_write_access(
    State(state): State<AppState>,
    params: Option<Path<HashMap<String, String>>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let Some(access) = state.tasks.write_access() else {
        return next.run(request).await;
    };
    if matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        return next.run(request).await;
    }
    let Some(Path(params)) = params else {
        return next.run(request).await;
    };
    let Some(repo_id) = params.get("repo_id").cloned() else {
        return next.run(request).await;
    };
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| path.as_str())
        .unwrap_or("");
    if *request.method() == Method::DELETE
        && route.strip_prefix("/api").unwrap_or(route) == "/v1/repositories/:repo_id"
    {
        if let Err(error) = access.check_catalog(&repo_id).await {
            return access_error(error).into_response();
        }
        return next.run(request).await;
    }
    if route.ends_with("/favorite")
        || route.ends_with("/branches/delete-preview")
        || route.ends_with("/workflows/conflicts/suggestion")
        || route.ends_with("/pipelines/rules/import")
    {
        return next.run(request).await;
    }
    if !is_direct_write(request.method(), route) {
        // Do not hold a permit across a handler which may submit work or run a
        // pipeline: a waiting exclusive claimant would deadlock nested readers.
        if let Err(error) = state.tasks.check_write(&repo_id).await {
            return access_error(error).into_response();
        }
        return next.run(request).await;
    }
    // A disconnected client must not drop the coordination permit while the
    // handler is still waiting for a blocking filesystem/Git write to finish.
    tokio::spawn(async move {
        let target = match state.repository_targets.task_target(&repo_id).await {
            Ok(target) => target,
            Err(error) => return ApiError::from_repository_error(error).into_response(),
        };
        let _execution = state
            .tasks
            .lock_repository_write(&target.resource_key)
            .await;
        let _permit = match state.tasks.write_permit(&repo_id).await {
            Ok(permit) => permit,
            Err(error) => return access_error(error).into_response(),
        };
        next.run(request).await
    })
    .await
    .unwrap_or_else(|_| ApiError::task_submit(TaskSubmitError::StorageUnavailable).into_response())
}
