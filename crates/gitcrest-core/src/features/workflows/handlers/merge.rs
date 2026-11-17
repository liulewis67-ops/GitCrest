use axum::{
    extract::{rejection::JsonRejection, rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use super::super::{
    dto::{WorkflowPreflightDto, WorkflowPreflightQuery, WorkflowRequest},
    service as workflows,
};
use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::workflow::WorkflowAction,
    features::tasks::{TaskFailure, TaskSnapshot},
    state::AppState,
};

pub(in crate::features::workflows) async fn preflight_repository_workflow(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<WorkflowPreflightQuery>, QueryRejection>,
) -> Result<Json<WorkflowPreflightDto>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Workflow preflight requires an action and targetOid.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let action = WorkflowAction::from(query.action);
    workflows::read_preflight(
        &state.git_commands,
        repo_id,
        &target.repository_path,
        action,
        &query.target_oid,
    )
    .await
    .map(WorkflowPreflightDto::from)
    .map(Json)
    .map_err(ApiError::from_workflow_error)
}

pub(in crate::features::workflows) async fn start_repository_workflow(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<WorkflowRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A workflow action, targetOid, and expectedHeadOid are required.",
        )
    })?;
    let action = WorkflowAction::from(request.action);
    if request.no_fast_forward && action != WorkflowAction::Merge {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "noFastForward only applies to merge.",
        ));
    }
    let no_fast_forward = request.no_fast_forward;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let preview = workflows::read_preflight(
        &state.git_commands,
        repo_id.clone(),
        &target.repository_path,
        action,
        &request.target_oid,
    )
    .await
    .map_err(ApiError::from_workflow_error)?;
    if preview.head_oid.as_deref() != Some(request.expected_head_oid.as_str())
        || preview.target_oid != request.target_oid
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowPreflightStale,
            "HEAD or the selected commit changed after preflight. Refresh the workflow preview.",
        ));
    }
    if !preview.can_start {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowRequiresClean,
            "The selected workflow cannot start in the current repository state.",
        ));
    }
    let command = state.git_commands.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let target_oid = request.target_oid;
    let expected_head_oid = request.expected_head_oid;
    let operation = match action {
        WorkflowAction::Merge => "merge",
        WorkflowAction::CherryPick => "cherryPick",
        WorkflowAction::Revert => "revert",
    };
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            operation,
            move |context| async move {
                let current = workflows::read_preflight(
                    &command,
                    task_repo_id.clone(),
                    &path,
                    action,
                    &target_oid,
                )
                .await
                .map_err(|_| {
                    TaskFailure::Failed(
                        "Workflow preconditions could not be rechecked. Refresh repository state.".into(),
                    )
                })?;
                if current.head_oid.as_deref() != Some(expected_head_oid.as_str())
                    || current.target_oid != target_oid
                    || !current.can_start
                {
                    return Err(TaskFailure::Failed(
                        "Workflow preconditions changed before Git could start. Review the current repository state.".into(),
                    ));
                }
                let task_context = context.clone();
                let result = command
                    .execute_workflow(&path, action, &target_oid, no_fast_forward, !current.is_clean, context)
                    .await;
                if result.is_ok() && repositories.refresh_metadata(&task_repo_id).await.is_err() {
                    task_context
                        .log("Repository metadata refresh failed after the Git operation; refresh the repository before the next write.")
                        .await;
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
