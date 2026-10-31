use axum::{
    routing::{get, post},
    Router,
};

use crate::state::AppState;

use super::handlers::{
    export_rules, get_app_settings, get_repository_settings, get_rules, get_run, import_rules,
    list_runs, put_app_settings, put_repository_settings, put_rules, run_action, start_run,
    write_rules_file,
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
        .route(
            "/v1/repositories/:repo_id/pipelines/rules/export",
            get(export_rules).post(write_rules_file),
        )
        .route(
            "/v1/repositories/:repo_id/pipelines/rules/import",
            post(import_rules),
        )
        .route(
            "/v1/repositories/:repo_id/pipelines/runs",
            get(list_runs).post(start_run),
        )
        .route(
            "/v1/repositories/:repo_id/pipelines/runs/:run_id",
            get(get_run),
        )
        .route(
            "/v1/repositories/:repo_id/pipelines/runs/:run_id/actions",
            post(run_action),
        )
}
