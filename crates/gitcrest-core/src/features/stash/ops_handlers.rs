use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::{
        diff::DiffScope,
        git_result::GitFailureCode,
        shelf::{ShelfRecord, ShelfSnapshot},
        status::{overlapping_worktree_paths, StatusFile},
        time::unix_time_ms,
    },
    features::shelves,
    state::AppState,
    TaskFailure, TaskSnapshot,
};

use super::{
    dto::{
        StashApplyRequest, StashDropRequest, StashDropStatus, StashDropped, StashImportRequest,
        StashImported, StashPreview, StashPreviewQuery,
    },
    ops,
    service::StashError,
};

pub(super) fn api_error(error: StashError) -> ApiError {
    match error {
        StashError::Invalid => ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A full stash commit ID is required.",
        ),
        StashError::NotFound => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::StashNotFound,
            "This stash entry no longer exists or has moved. Refresh the list and review it again.",
        ),
        StashError::TooLarge => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ApiErrorCode::HistoryTooLarge,
            "The stash is too large to handle here.",
        ),
        StashError::GitUnavailable => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::GitUnavailable,
            "Git could not be started. Install Git or check that it is on PATH.",
        ),
        StashError::TimedOut | StashError::Failed => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorCode::HistoryUnavailable,
            "Git could not complete the stash request.",
        ),
    }
}

fn invalid_body() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        ApiErrorCode::RequestInvalid,
        "The stash request is incomplete.",
    )
}

pub(super) async fn preview_stash(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<StashPreviewQuery>, QueryRejection>,
) -> Result<Json<StashPreview>, ApiError> {
    let Query(query) = query.map_err(|_| invalid_body())?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let entry = ops::entry_for(&target.repository_path, &query.oid)
        .await
        .map_err(api_error)?;
    let mut paths = ops::restore_paths(&target.repository_path, &entry)
        .await
        .map_err(api_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let status = state
        .status
        .snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let overlapping_dirty_paths: Vec<String> = status
        .files
        .iter()
        .filter(|file| file.has_unignored_changes() && paths.contains(&file.path))
        .map(|file| file.path.clone())
        .collect();
    let operation_in_progress =
        metadata.state != "normal" || status.files.iter().any(StatusFile::is_conflicted);
    let omitted_path_count = paths.len().saturating_sub(ops::MAX_LISTED_PATHS);
    paths.truncate(ops::MAX_LISTED_PATHS);
    Ok(Json(StashPreview {
        repo_id,
        oid: entry.oid,
        index: entry.index,
        head_oid: metadata.head,
        base_oid: entry.base_oid,
        paths,
        omitted_path_count,
        can_apply: !operation_in_progress,
        overlapping_dirty_paths,
        operation_in_progress,
    }))
}

pub(super) async fn apply_stash(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<StashApplyRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| invalid_body())?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let entry = ops::entry_for(&target.repository_path, &request.oid)
        .await
        .map_err(api_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    if metadata.state != "normal" {
        return Err(ApiError::state_conflict(
            "Finish the running merge, rebase or similar operation before applying a stash.",
        ));
    }
    if request.expected_head_oid.is_some() && request.expected_head_oid != metadata.head {
        return Err(ApiError::state_conflict(
            "HEAD moved after the stash was reviewed. Review it again before applying.",
        ));
    }
    let path = target.repository_path;
    let commands = state.git_commands.clone();
    let before_index = commands.read_index_tree(&path).await.map_err(|_| {
        ApiError::state_conflict("Resolve existing index conflicts before applying a stash.")
    })?;
    let status_service = state.status.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let expected_head = metadata.head;
    let oid = entry.oid.clone();
    let pop = request.pop;
    let operation = if pop { "stashPop" } else { "stashApply" };
    let operation = format!("{operation}:{oid}:{before_index}");
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            &operation,
            move |context| async move {
                let entry = ops::entry_for(&path, &oid).await.map_err(|_| {
                    TaskFailure::Failed(
                        "The stash entry changed before it could be applied. Review it again."
                            .into(),
                    )
                })?;
                let repository = repositories.refresh_metadata(&task_repo_id).await
                    .map_err(|_| TaskFailure::command_failed("Could not check the stash target.".into()))?;
                if repository.state != "normal" || repository.head != expected_head
                    || commands.read_index_tree(&path).await? != before_index
                {
                    return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "The repository changed before applying the stash. Review it again."));
                }
                let changes = status_service.snapshot(&task_repo_id).await
                    .map_err(|_| TaskFailure::command_failed("Could not inspect local changes before applying the stash.".into()))?;
                let saved_paths = ops::restore_paths(&path, &entry).await
                    .map_err(|_| TaskFailure::command_failed("Could not read the saved stash paths.".into()))?;
                let local_paths = overlapping_worktree_paths(&changes.files, &saved_paths);
                let indexed_overlap = if let Some(untracked) = entry.untracked_oid.as_deref().filter(|_| local_paths.is_empty()) {
                    ops::untracked_overlaps_index(&path, untracked, &before_index).await
                        .map_err(|_| TaskFailure::command_failed("Could not check the stash's untracked paths against the index.".into()))?
                } else { false };
                let merge_saved = !local_paths.is_empty() || indexed_overlap;
                let applied = if merge_saved {
                    let base = entry.base_oid.as_deref().ok_or_else(|| TaskFailure::command_failed("The stash base is unavailable.".into()))?;
                    commands.merge_stash_with_local_changes(
                        &path, (base, &before_index, &oid), entry.untracked_oid.as_deref(), &local_paths, context.clone(),
                    ).await
                } else {
                    commands.execute_stash_apply(&path, &oid, context.clone()).await
                };
                if let Err(error) = applied {
                    let status = status_service.snapshot(&task_repo_id).await.map_err(|_| {
                        TaskFailure::diagnosed(GitFailureCode::OutcomeUnknown, "The stash outcome could not be checked. The stash entry was retained.")
                    })?;
                    if status.files.iter().any(StatusFile::is_conflicted) {
                        return Err(error.with_code(GitFailureCode::RestoreConflict, "The stash has conflicts. Resolve the affected files, then continue. The stash entry was retained."));
                    }
                    return Err(error);
                }
                if merge_saved {
                    commands.restore_saved_change_index(&path, saved_paths, before_index, &context).await?;
                }
                if pop {
                    ops::drop_entry(&path, &oid).await.map_err(|_| {
                        TaskFailure::Failed(
                            "The stash was applied, but the original entry could not be dropped."
                                .into(),
                        )
                    })?;
                }
                Ok(None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn drop_stash(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<StashDropRequest>, JsonRejection>,
) -> Result<Json<StashDropped>, ApiError> {
    let Json(request) = request.map_err(|_| invalid_body())?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    ops::drop_entry(&target.repository_path, &request.oid)
        .await
        .map_err(api_error)?;
    Ok(Json(StashDropped {
        repo_id,
        oid: request.oid,
    }))
}

pub(super) async fn import_stash(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<StashImportRequest>, JsonRejection>,
) -> Result<Json<StashImported>, ApiError> {
    let Json(request) = request.map_err(|_| invalid_body())?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let entry = ops::entry_for(&target.repository_path, &request.oid)
        .await
        .map_err(api_error)?;
    let paths = ops::changed_paths(&target.repository_path, &entry)
        .await
        .map_err(api_error)?;
    let patch = ops::import_patch(&target.repository_path, &entry)
        .await
        .map_err(api_error)?;
    shelves::validate_patch(&patch, &paths).map_err(ApiError::from_shelf_error)?;
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let message: String = entry
                .message
                .chars()
                .filter(|c| !c.is_control())
                .take(120)
                .collect();
            if message.trim().is_empty() {
                format!("stash@{{{}}}", entry.index)
            } else {
                message
            }
        });
    let description = format!(
        "Imported from Git stash{}.",
        entry
            .branch
            .as_deref()
            .map(|branch| format!(" made on {branch}"))
            .unwrap_or_default()
    );
    shelves::validate_metadata(&name, &description).map_err(ApiError::from_shelf_error)?;
    let shelf_id = shelves::new_shelf_id();
    let path_count = paths.len();
    let record = ShelfRecord {
        snapshot: ShelfSnapshot {
            shelf_id: shelf_id.clone(),
            repo_id: repo_id.clone(),
            name: name.clone(),
            description,
            paths,
            scope: Some(DiffScope::WorkingTree),
            head_oid: entry.base_oid.clone(),
            created_at_ms: unix_time_ms(),
        },
        patch,
    };
    let store = state.shelf_store.clone();
    tokio::task::spawn_blocking(move || store.save_shelf_record(record))
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::InternalError,
                "The shelf could not be saved.",
            )
        })?
        .map_err(ApiError::from_repository_error)?;
    // The shelf is saved first, so a failed drop never loses the changes.
    let drop_status = if request.drop_after {
        match ops::drop_entry(&target.repository_path, &entry.oid).await {
            Ok(()) => StashDropStatus::Dropped,
            Err(_) => StashDropStatus::Failed,
        }
    } else {
        StashDropStatus::NotRequested
    };
    Ok(Json(StashImported {
        repo_id,
        shelf_id,
        name,
        path_count,
        dropped: matches!(drop_status, StashDropStatus::Dropped),
        drop_status,
    }))
}
