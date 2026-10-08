use axum::{
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderName, HeaderValue, Method,
    },
    middleware,
    routing::{get, post, put},
    Router,
};
use tower_http::cors::CorsLayer;

#[cfg(test)]
use crate::write_probe;

use crate::{
    add_api_version_header, add_repository_remote, api_not_found, apply_repository_shelf,
    cancel_task, clone_repository, commit_repository, create_repository_branch,
    create_repository_shelf, delete_ai_credential, delete_credential, delete_repository_branch,
    delete_repository_remote, delete_repository_remote_branch, delete_repository_shelf,
    discard_repository_patch, events, fetch_repository, forget_repository, get_ai_settings,
    get_credential_status, get_repository, get_repository_shelf, get_task,
    get_workflow_conflict_ai_settings, initialize_repository, list_repositories,
    list_repository_rebase_backups, list_repository_reset_backups, list_repository_shelves,
    list_tasks, mark_workflow_conflict_resolved, open_repository, preflight_branch_switch,
    preflight_repository_pull, preflight_repository_push, preflight_repository_rebase,
    preflight_repository_reset, preflight_repository_shelf_apply, preflight_repository_workflow,
    preflight_repository_workflow_recovery, preview_repository_branch_delete,
    preview_repository_remote_branch_delete, pull_repository, push_repository,
    read_workflow_conflict_file, recover_repository_workflow, rename_repository_branch,
    repository_blame, repository_branches, repository_commit_create_tag, repository_commit_detail,
    repository_commit_file_diff, repository_commits, repository_diff, repository_refs,
    repository_remotes, repository_status, request_ai, request_workflow_conflict_suggestion,
    require_api_version, require_auth, restore_repository_reset, rollback_repository_rebase,
    save_workflow_conflict_file, set_ai_credential, set_ai_settings, set_branch_favorite,
    set_branch_upstream, set_credential, set_default_remote, set_repository_favorite,
    set_repository_remote_url, stage_repository, stage_repository_patch, start_repository_rebase,
    start_repository_reset, start_repository_workflow, switch_repository_branch, system,
    undo_recent_operation, AppState,
};

pub(crate) fn app_router(state: AppState, cors_origin: Option<HeaderValue>) -> Router {
    let api = system::routes::api_router()
        .route(
            "/v1/repositories",
            get(list_repositories).post(open_repository),
        )
        .route("/v1/repositories/initialize", post(initialize_repository))
        .route(
            "/v1/repositories/:repo_id",
            get(get_repository).delete(forget_repository),
        )
        .route(
            "/v1/repositories/:repo_id/favorite",
            put(set_repository_favorite),
        )
        .route("/v1/repositories/:repo_id/status", get(repository_status))
        .route("/v1/repositories/:repo_id/diff", get(repository_diff))
        .route("/v1/repositories/:repo_id/blame", get(repository_blame))
        .route(
            "/v1/repositories/:repo_id/branches",
            get(repository_branches).post(create_repository_branch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/rename",
            post(rename_repository_branch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/delete-preview",
            post(preview_repository_branch_delete),
        )
        .route(
            "/v1/repositories/:repo_id/branches/delete",
            post(delete_repository_branch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/remote-delete-preview",
            get(preview_repository_remote_branch_delete),
        )
        .route(
            "/v1/repositories/:repo_id/branches/remote-delete",
            post(delete_repository_remote_branch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/favorite",
            put(set_branch_favorite),
        )
        .route(
            "/v1/repositories/:repo_id/branches/switch-preflight",
            get(preflight_branch_switch),
        )
        .route(
            "/v1/repositories/:repo_id/branches/switch",
            post(switch_repository_branch),
        )
        .route(
            "/v1/repositories/:repo_id/remotes",
            get(repository_remotes).post(add_repository_remote),
        )
        .route(
            "/v1/repositories/:repo_id/remotes/url",
            put(set_repository_remote_url),
        )
        .route(
            "/v1/repositories/:repo_id/remotes/delete",
            post(delete_repository_remote),
        )
        .route(
            "/v1/repositories/:repo_id/remotes/default",
            put(set_default_remote),
        )
        .route(
            "/v1/repositories/:repo_id/remotes/upstream",
            put(set_branch_upstream),
        )
        .route(
            "/v1/credentials",
            get(get_credential_status)
                .put(set_credential)
                .delete(delete_credential),
        )
        .route("/v1/ai/settings", get(get_ai_settings).put(set_ai_settings))
        .route(
            "/v1/ai/credential",
            put(set_ai_credential).delete(delete_ai_credential),
        )
        .route("/v1/repositories/:repo_id/ai/request", post(request_ai))
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
        .route(
            "/v1/repositories/:repo_id/shelves",
            get(list_repository_shelves).post(create_repository_shelf),
        )
        .route(
            "/v1/repositories/:repo_id/shelves/:shelf_id",
            get(get_repository_shelf).delete(delete_repository_shelf),
        )
        .route(
            "/v1/repositories/:repo_id/shelves/:shelf_id/apply-preview",
            get(preflight_repository_shelf_apply),
        )
        .route(
            "/v1/repositories/:repo_id/shelves/:shelf_id/apply",
            post(apply_repository_shelf),
        )
        .route(
            "/v1/repositories/:repo_id/commits",
            get(repository_commits).post(commit_repository),
        )
        .route(
            "/v1/repositories/:repo_id/commits/:oid",
            get(repository_commit_detail),
        )
        .route(
            "/v1/repositories/:repo_id/commits/:oid/diff",
            get(repository_commit_file_diff),
        )
        .route(
            "/v1/repositories/:repo_id/commits/:oid/tags",
            post(repository_commit_create_tag),
        )
        .route("/v1/repositories/:repo_id/refs", get(repository_refs))
        .route("/v1/repositories/:repo_id/fetch", post(fetch_repository))
        .route(
            "/v1/repositories/:repo_id/pull-preflight",
            get(preflight_repository_pull),
        )
        .route("/v1/repositories/:repo_id/pull", post(pull_repository))
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
        .route(
            "/v1/repositories/:repo_id/push-preflight",
            get(preflight_repository_push),
        )
        .route("/v1/repositories/:repo_id/push", post(push_repository))
        .route("/v1/clones", post(clone_repository))
        .route("/v1/tasks", get(list_tasks))
        .route("/v1/tasks/:task_id", get(get_task))
        .route("/v1/tasks/:task_id/cancel", post(cancel_task))
        .route("/v1/events", get(events))
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
