use axum::{
    extract::{rejection::JsonRejection, rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use super::super::dto::{
    RebaseBackupSnapshotDto, RebasePreviewDto, RebasePreviewQuery, RebaseRequest,
    RebaseRollbackRequest,
};
use super::super::rebase;
use crate::{
    api::error::{ApiError, ApiErrorCode},
    state::AppState,
    tasks::{TaskFailure, TaskSnapshot},
};

pub(in crate::features::workflows) async fn preflight_repository_rebase(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<RebasePreviewQuery>, QueryRejection>,
) -> Result<Json<RebasePreviewDto>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Rebase preview requires an ontoOid commit.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    rebase::read_preview(
        &state.git_commands,
        repo_id,
        &target.repository_path,
        &query.onto_oid,
    )
    .await
    .map(RebasePreviewDto::from)
    .map(Json)
    .map_err(ApiError::from_workflow_error)
}

pub(in crate::features::workflows) async fn start_repository_rebase(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RebaseRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Starting a rebase requires the reviewed HEAD, onto commit, and preview revision.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let preview = rebase::read_preview(
        &state.git_commands,
        repo_id.clone(),
        &target.repository_path,
        &request.expected_onto_oid,
    )
    .await
    .map_err(ApiError::from_workflow_error)?;
    let todo = request
        .todo
        .into_iter()
        .map(crate::domain::workflow::RebaseTodoItem::from)
        .collect::<Vec<_>>();
    if preview.head_oid.as_deref() != Some(request.expected_head_oid.as_str())
        || preview.onto_oid != request.expected_onto_oid
        || preview.preview_revision != request.preview_revision
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowPreflightStale,
            "HEAD, target, or commit list changed after review. Refresh the rebase preview.",
        ));
    }
    if !preview.can_start {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowRequiresClean,
            "Rebase requires a clean branch, a non-empty bounded commit list, and no Git operation in progress.",
        ));
    }
    rebase::validate_todo(
        &preview,
        &todo,
        request.confirm_drop,
        request.confirm_published_rewrite,
    )
    .map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            match error {
                rebase::RebaseTodoError::StaleCommit => {
                    "The todo must contain each reviewed commit exactly once."
                }
                rebase::RebaseTodoError::EmptySequence => {
                    "A rebase todo must keep at least one commit."
                }
                rebase::RebaseTodoError::InvalidActionOrder => {
                    "Squash and fixup require an earlier non-dropped commit."
                }
                rebase::RebaseTodoError::DropConfirmationRequired => {
                    "Dropping commits requires explicit confirmation."
                }
                rebase::RebaseTodoError::PublishedConfirmationRequired => {
                    "Rewriting commits already present on a remote requires explicit confirmation."
                }
                rebase::RebaseTodoError::MessageRequired => {
                    "Every reword action requires a non-empty replacement message."
                }
                rebase::RebaseTodoError::UnexpectedMessage => {
                    "Replacement messages are only accepted for reword actions."
                }
            },
        )
    })?;
    let command = state.git_commands.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let expected_head_oid = request.expected_head_oid;
    let onto_oid = request.expected_onto_oid;
    let expected_preview_revision = request.preview_revision;
    let confirm_drop = request.confirm_drop;
    let confirm_published_rewrite = request.confirm_published_rewrite;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            "rebase",
            move |context| async move {
                let current = rebase::read_preview(&command, task_repo_id.clone(), &path, &onto_oid)
                    .await
                    .map_err(|_| {
                        TaskFailure::Failed(
                            "Rebase preconditions could not be rechecked. Refresh repository state.".into(),
                        )
                    })?;
                if current.head_oid.as_deref() != Some(expected_head_oid.as_str())
                    || current.onto_oid != onto_oid
                    || current.preview_revision != expected_preview_revision
                    || !current.can_start
                {
                    return Err(TaskFailure::Failed(
                        "Rebase preconditions changed before Git could start. Review the current repository state.".into(),
                    ));
                }
                rebase::validate_todo(
                    &current,
                    &todo,
                    confirm_drop,
                    confirm_published_rewrite,
                )
                .map_err(|_| {
                    TaskFailure::Failed(
                        "The reviewed rebase todo is no longer valid. Review the current commit sequence.".into(),
                    )
                })?;
                let plan = crate::domain::workflow::RebaseExecutionPlan {
                    expected_head_oid: current.head_oid.clone().ok_or_else(|| {
                        TaskFailure::Failed(
                            "The reviewed rebase no longer has a branch HEAD.".into(),
                        )
                    })?,
                    onto_oid: current.onto_oid.clone(),
                    commits: current
                        .commits
                        .iter()
                        .map(|commit| crate::domain::workflow::RebaseCommitSubject {
                            oid: commit.oid.clone(),
                            subject: commit.subject.clone(),
                        })
                        .collect(),
                    todo,
                };
                let task_context = context.clone();
                let result = command
                    .execute_rebase(&path, &plan, context)
                    .await;
                if result.is_ok() && repositories.refresh_metadata(&task_repo_id).await.is_err() {
                    task_context
                        .log("Repository metadata refresh failed after rebase; refresh the repository before the next write.")
                        .await;
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(in crate::features::workflows) async fn list_repository_rebase_backups(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<RebaseBackupSnapshotDto>, ApiError> {
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    rebase::read_backup_snapshot(&state.git_commands, &target.repository_path)
        .await
        .map(RebaseBackupSnapshotDto::from)
        .map(Json)
        .map_err(ApiError::from_workflow_error)
}

fn is_rebase_backup_reference(reference: &str) -> bool {
    let Some(suffix) = reference.strip_prefix("refs/gitcrest/rebase-backups/") else {
        return false;
    };
    !suffix.is_empty()
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub(in crate::features::workflows) async fn rollback_repository_rebase(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RebaseRollbackRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Rebase rollback requires the reviewed HEAD and a backup reference.",
        )
    })?;
    if !request.confirm_rollback || !is_rebase_backup_reference(&request.backup_reference) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Rollback requires explicit confirmation and a GitCrest rebase backup reference.",
        ));
    }
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = rebase::read_backup_snapshot(&state.git_commands, &target.repository_path)
        .await
        .map_err(ApiError::from_workflow_error)?;
    if snapshot.head_oid.as_deref() != Some(request.expected_head_oid.as_str())
        || !snapshot.can_rollback
        || !snapshot.backups.iter().any(|backup| {
            backup.reference == request.backup_reference && backup.oid == request.backup_oid
        })
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowPreflightStale,
            "The current branch, worktree, or selected backup changed. Refresh the rollback review.",
        ));
    }
    let command = state.git_commands.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let expected_head_oid = request.expected_head_oid;
    let backup_reference = request.backup_reference;
    let backup_oid = request.backup_oid;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            "rebaseRollback",
            move |context| async move {
                let current = rebase::read_backup_snapshot(&command, &path).await.map_err(|_| {
                    TaskFailure::Failed(
                        "Rollback preconditions could not be rechecked. Refresh repository state.".into(),
                    )
                })?;
                if current.head_oid.as_deref() != Some(expected_head_oid.as_str())
                    || !current.can_rollback
                    || !current.backups.iter().any(|backup| {
                        backup.reference == backup_reference && backup.oid == backup_oid
                    })
                {
                    return Err(TaskFailure::Failed(
                        "Rollback preconditions changed before Git could start. Review the current repository state.".into(),
                    ));
                }
                let task_context = context.clone();
                let result = command
                    .execute_rebase_rollback(
                        &path,
                        &expected_head_oid,
                        &backup_oid,
                        &backup_reference,
                        context,
                    )
                    .await;
                if result.is_ok() && repositories.refresh_metadata(&task_repo_id).await.is_err() {
                    task_context
                        .log("Repository metadata refresh failed after rollback; refresh the repository before the next write.")
                        .await;
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
