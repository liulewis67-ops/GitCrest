use axum::{routing::get, Router};

use crate::{
    get_workflow_conflict_ai_settings, list_repository_reset_backups,
    mark_workflow_conflict_resolved, preflight_repository_reset,
    preflight_repository_workflow_recovery, read_workflow_conflict_file,
    recover_repository_workflow, request_workflow_conflict_suggestion, restore_repository_reset,
    save_workflow_conflict_file, start_repository_reset, state::AppState,
};

use super::handlers::{
    list_repository_rebase_backups, preflight_repository_rebase, preflight_repository_workflow,
    rollback_repository_rebase, start_repository_rebase, start_repository_workflow,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
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
            axum::routing::post(rollback_repository_rebase),
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
            axum::routing::post(restore_repository_reset),
        )
        .route(
            "/v1/repositories/:repo_id/workflows",
            axum::routing::post(start_repository_workflow),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/recovery-preflight",
            get(preflight_repository_workflow_recovery),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/recovery",
            axum::routing::post(recover_repository_workflow),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/conflicts/file",
            get(read_workflow_conflict_file).put(save_workflow_conflict_file),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/conflicts/resolved",
            axum::routing::post(mark_workflow_conflict_resolved),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/conflicts/suggestion",
            axum::routing::post(request_workflow_conflict_suggestion),
        )
        .route(
            "/v1/repositories/:repo_id/workflows/conflicts/ai-settings",
            get(get_workflow_conflict_ai_settings),
        )
}
