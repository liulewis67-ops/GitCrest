use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::remote::RemotePushCommand,
    features::remotes::push,
    AppState, TaskFailure, TaskSnapshot,
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum SyncOperation {
    Pull,
    Push,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SyncRequest {
    name: String,
    expected_oid: String,
    operation: SyncOperation,
}

/// Sync an explicitly reviewed local branch without checking it out or forcing a push.
pub(super) async fn sync_branch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<SyncRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A local branch, reviewed commit and pull or push operation are required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    super::require_local_branch_with_git(
        &target.repository_path,
        &request.name,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    if ![40, 64].contains(&request.expected_oid.len())
        || !request
            .expected_oid
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A reviewed branch commit is required.",
        ));
    }
    let path = target.repository_path;
    let operation = match request.operation {
        SyncOperation::Pull => "pullFastForward",
        SyncOperation::Push => "push",
    };
    let task_repo = repo_id.clone();
    let tasks = state.tasks.clone();
    let task = tasks.submit(Some(repo_id), None, target.resource_key, operation, move |context| async move {
        let preview = push::read_push_preflight_for_target(
            task_repo.clone(), &path, Some(&request.name), false, None,
            state.branch_git.as_ref(), state.remote_git.as_ref(),
        ).await.map_err(|_| TaskFailure::Failed("This branch has no usable upstream. Configure its upstream before syncing.".into()))?;
        if preview.local_oid != request.expected_oid {
            return Err(TaskFailure::Failed("The branch changed after selection. Refresh and try again.".into()));
        }
        context.log(format!("{} → {}/{}", request.name, preview.remote_name, preview.remote_branch)).await;
        match request.operation {
            SyncOperation::Push => {
                state.remote_commands.push(&path, RemotePushCommand::from(&preview), false, context).await?;
                state.pipelines.on_push_succeeded(
                    crate::features::pipelines::service::PushedBranch { repo_id: task_repo, branch: request.name, oid: preview.local_oid },
                    crate::features::pipelines::engine::PushOrigin::User,
                ).await;
            }
            SyncOperation::Pull => {
                state.git_commands.fast_forward_upstream(
                    &path, &request.name, &request.expected_oid, &preview.remote_name, &preview.remote_branch, context,
                ).await?;
            }
        }
        Ok(None)
    }).await.map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
