use std::sync::Arc;

use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};
use sha2::{Digest, Sha256};

use super::dto::{
    ShelfApplyPreviewResponse, ShelfApplyRequest, ShelfCreateRequest, ShelfDetailResponse,
    ShelfSelectionRequest, ShelfSnapshotDto,
};
use super::preparation::{self, PreparationError, PreparedShelf, ShelfSelection};
use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::diff::DiffScope,
    domain::git_result::GitFailureCode,
    domain::shelf::ShelfRecord,
    domain::staging::StagingOperation,
    features::diff,
    features::tasks::{TaskFailure, TaskSnapshot},
    features::{repositories::repository::RepositoryManager, shelves, staging},
    ports::diff::{DiffGitPort, DiffWorktreePort},
    ports::shelves::ShelfStorePort,
    ports::{repository::RepositoryPathPort, status::StatusReadPort},
    state::AppState,
};

pub(super) async fn list_repository_shelves(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<Vec<ShelfSnapshotDto>>, ApiError> {
    state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let shelf_store = state.shelf_store.clone();
    let shelves = tokio::task::spawn_blocking(move || shelf_store.list_shelf_snapshots(&repo_id))
        .await
        .map_err(|_| ApiError::task_storage_unavailable())?
        .map_err(|_| ApiError::task_storage_unavailable())?;
    Ok(Json(shelves.into_iter().map(Into::into).collect()))
}

pub(super) async fn get_repository_shelf(
    State(state): State<AppState>,
    Path((repo_id, shelf_id)): Path<(String, String)>,
) -> Result<Json<ShelfDetailResponse>, ApiError> {
    state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let shelf = load_shelf_record(state.shelf_store.clone(), &repo_id, &shelf_id).await?;
    let patch = String::from_utf8(shelf.patch).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "The saved shelf preview could not be decoded.",
        )
    })?;
    Ok(Json(ShelfDetailResponse {
        shelf: shelf.snapshot.into(),
        patch,
    }))
}

pub(super) async fn delete_repository_shelf(
    State(state): State<AppState>,
    Path((repo_id, shelf_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let shelf_store = state.shelf_store.clone();
    let deleted =
        tokio::task::spawn_blocking(move || shelf_store.delete_shelf_record(&repo_id, &shelf_id))
            .await
            .map_err(|_| ApiError::task_storage_unavailable())?
            .map_err(|_| ApiError::task_storage_unavailable())?;
    if !deleted {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ShelfNotFound,
            "This shelf is no longer available.",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn preflight_repository_shelf_apply(
    State(state): State<AppState>,
    Path((repo_id, shelf_id)): Path<(String, String)>,
) -> Result<Json<ShelfApplyPreviewResponse>, ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let repository = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let shelf = load_shelf_record(state.shelf_store.clone(), &repo_id, &shelf_id).await?;
    let scope = shelf.snapshot.scope.ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::ResourceVersionStale,
            "This shelf predates scope metadata and cannot be applied automatically.",
        )
    })?;
    let preview_revision = shelf_apply_revision(
        &state.git_commands,
        state.diff_worktree.as_ref(),
        &state.status,
        &repo_id,
        &target.repository_path,
        &shelf,
        repository.head.as_deref(),
    )
    .await?;
    let can_apply_cleanly = shelves::check_apply(
        state.shelf_patch_checker.as_ref(),
        &target.repository_path,
        &shelf.patch,
        scope,
    )
    .await
    .map_err(ApiError::from_shelf_error)?;
    let can_apply_with_conflicts = !can_apply_cleanly
        && can_shelf_apply_with_conflicts(
            &state.repositories,
            &state.status,
            &repo_id,
            &shelf,
            repository.head.as_deref(),
        )
        .await?;
    Ok(Json(ShelfApplyPreviewResponse {
        shelf: shelf.snapshot.into(),
        expected_head_oid: repository.head,
        preview_revision,
        can_apply_cleanly,
        can_apply_with_conflicts,
    }))
}

pub(super) async fn apply_repository_shelf(
    State(state): State<AppState>,
    Path((repo_id, shelf_id)): Path<(String, String)>,
    request: Result<Json<ShelfApplyRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Applying a shelf requires the reviewed HEAD and preview revision.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let repository = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    if repository.head != request.expected_head_oid {
        return Err(ApiError::from_staging_error(
            staging::StagingError::StaleSelection,
        ));
    }
    let shelf = load_shelf_record(state.shelf_store.clone(), &repo_id, &shelf_id).await?;
    let scope = shelf.snapshot.scope.ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::ResourceVersionStale,
            "This shelf predates scope metadata and cannot be applied automatically.",
        )
    })?;
    let current_revision = shelf_apply_revision(
        &state.git_commands,
        state.diff_worktree.as_ref(),
        &state.status,
        &repo_id,
        &target.repository_path,
        &shelf,
        repository.head.as_deref(),
    )
    .await?;
    if current_revision != request.preview_revision {
        return Err(ApiError::from_staging_error(
            staging::StagingError::StaleSelection,
        ));
    }
    let before_index_tree = state
        .git_commands
        .read_index_tree(&target.repository_path)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::WorkflowPreflightUnavailable,
                "Git could not capture the index state for shelf recovery.",
            )
        })?;

    let repositories = state.repositories.clone();
    let shelf_store = state.shelf_store.clone();
    let undo_store = state.undo_store.clone();
    let status_service = state.status.clone();
    let commands = state.git_commands.clone();
    let diff_worktree = state.diff_worktree.clone();
    let patch_checker = state.shelf_patch_checker.clone();
    let task_repo_id = repo_id.clone();
    let task_shelf_id = shelf_id;
    let task_path = target.repository_path;
    let resource_key = target.resource_key;
    let expected_head_oid = request.expected_head_oid;
    let expected_scope = scope;
    let preview_revision = request.preview_revision;
    let patch = shelf.patch;
    let task_operation = format!("shelfApply:{task_shelf_id}:{before_index_tree}");
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            &task_operation,
            move |context| async move {
                let current_repository = repositories
                    .refresh_metadata(&task_repo_id)
                    .await
                    .map_err(|_| TaskFailure::command_failed("Could not recheck repository HEAD before applying the shelf.".into()))?;
                if current_repository.head != expected_head_oid {
                    return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "Repository HEAD changed after shelf preview. Preview the shelf again."));
                }
                let current_shelf = load_shelf_record(shelf_store.clone(), &task_repo_id, &task_shelf_id)
                    .await
                    .map_err(|_| TaskFailure::command_failed("The reviewed shelf is no longer available.".into()))?;
                let current_scope = current_shelf.snapshot.scope.ok_or_else(|| TaskFailure::command_failed("This shelf has no safe restore scope.".into()))?;
                if current_scope != expected_scope {
                    return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "The shelf restore scope changed after preview. Preview it again."));
                }
                let current_revision = shelf_apply_revision(
                    &commands,
                    diff_worktree.as_ref(),
                    &status_service,
                    &task_repo_id,
                    &task_path,
                    &current_shelf,
                    current_repository.head.as_deref(),
                )
                .await
                .map_err(|_| TaskFailure::command_failed("Could not recheck the shelf target state. Preview it again.".into()))?;
                if current_revision != preview_revision {
                    return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "The working tree changed after shelf preview. Preview the shelf again."));
                }
                let can_apply = shelves::check_apply(
                    patch_checker.as_ref(),
                    &task_path,
                    &patch,
                    current_scope,
                )
                .await
                .map_err(|_| TaskFailure::command_failed("Git could not recheck the reviewed shelf patch.".into()))?;
                let clean_apply = if can_apply {
                    commands
                        .execute_staging(&task_path, shelves::restore_command(patch.clone(), current_scope), context.clone())
                        .await.map_err(super::restoration::restore_failure)?;
                    true
                } else {
                    let can_resolve_conflicts = can_shelf_apply_with_conflicts(
                        &repositories,
                        &status_service,
                        &task_repo_id,
                        &current_shelf,
                        current_repository.head.as_deref(),
                    )
                    .await
                    .map_err(|_| TaskFailure::command_failed("Could not verify that the shelf can enter conflict review.".into()))?;
                    if !can_resolve_conflicts {
                        return Err(TaskFailure::command_failed("The shelf conflicts with the current branch and cannot be merged safely. No changes were applied; the shelf is still available.".into()));
                    }
                    match commands
                        .execute_shelf_three_way(&task_path, patch.clone(), context.clone())
                        .await
                    {
                        Ok(()) => {
                            if current_scope == DiffScope::WorkingTree {
                                commands
                                    .execute_staging(
                                        &task_path,
                                        StagingOperation::RestoreShelfIndex {
                                            paths: current_shelf.snapshot.paths.clone(),
                                            tree: before_index_tree.clone(),
                                        },
                                        context.clone(),
                                    )
                                    .await.map_err(super::restoration::restore_failure)?;
                            }
                        }
                        Err(TaskFailure::Cancelled) => return Err(super::restoration::restore_failure(TaskFailure::Cancelled)),
                        Err(error) => {
                            let status = match status_service.snapshot(&task_repo_id).await {
                                Ok(status) => status,
                                Err(_) => return Err(error.with_code(GitFailureCode::OutcomeUnknown, "Git reported an apply failure and conflict state could not be inspected. The shelf was retained.")),
                            };
                            if status.files.iter().any(|file| file.is_conflicted() && current_shelf.snapshot.paths.contains(&file.path)) {
                                return Err(error.with_code(GitFailureCode::RestoreConflict, "The shelf has conflicts. Resolve the affected files, then continue to restore the saved changes."));
                            }
                            let message = format!("{}. The shelf was retained.", error.message());
                            return Err(error.with_message(message));
                        }
                    }
                    false
                };
                super::restoration::finish_applied_shelf(
                    current_shelf,
                    clean_apply.then(|| context.task_id().to_owned()),
                    shelf_store,
                    undo_store,
                ).await?;
                Ok(Some("The reviewed shelf was applied and removed from the saved shelf list.".into()))
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn load_shelf_record(
    shelf_store: Arc<dyn ShelfStorePort>,
    repo_id: &str,
    shelf_id: &str,
) -> Result<ShelfRecord, ApiError> {
    let repo_id = repo_id.to_owned();
    let shelf_id = shelf_id.to_owned();
    tokio::task::spawn_blocking(move || shelf_store.read_shelf_record(&repo_id, &shelf_id))
        .await
        .map_err(|_| ApiError::task_storage_unavailable())?
        .map_err(|_| ApiError::task_storage_unavailable())?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ShelfNotFound,
                "This shelf is no longer available.",
            )
        })
}

async fn can_shelf_apply_with_conflicts<R: RepositoryPathPort, G: StatusReadPort>(
    repositories: &RepositoryManager,
    status_service: &super::super::status::StatusService<R, G>,
    repo_id: &str,
    shelf: &ShelfRecord,
    head_oid: Option<&str>,
) -> Result<bool, ApiError> {
    if !shelf.snapshot.supports_three_way_apply(head_oid.is_some()) {
        return Ok(false);
    }
    let Some(repository) = repositories
        .get(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?
    else {
        return Ok(false);
    };
    let status = status_service
        .snapshot(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    Ok(shelf.snapshot.can_apply_with_conflicts(
        repository.state == "normal",
        head_oid.is_some(),
        &status.files,
    ))
}

async fn shelf_apply_revision<R: RepositoryPathPort, G: StatusReadPort>(
    git: &impl DiffGitPort,
    worktree: &dyn DiffWorktreePort,
    status_service: &super::super::status::StatusService<R, G>,
    repo_id: &str,
    repository_path: &std::path::Path,
    shelf: &ShelfRecord,
    head_oid: Option<&str>,
) -> Result<String, ApiError> {
    let status = status_service
        .snapshot(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let mut digest = Sha256::new();
    digest.update(head_oid.unwrap_or("<unborn>").as_bytes());
    digest.update(
        shelf
            .snapshot
            .scope
            .map(|scope| format!("{scope:?}"))
            .unwrap_or_default(),
    );
    digest.update(&shelf.patch);
    for path in &shelf.snapshot.paths {
        digest.update(path.as_bytes());
        digest.update([0]);
        if let Some(file) = status.files.iter().find(|file| file.path == *path) {
            if file.is_conflicted() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    ApiErrorCode::WorkflowNoActiveOperation,
                    "Resolve existing conflicts before previewing a shelf for this file.",
                ));
            }
            for scope in [DiffScope::Index, DiffScope::WorkingTree] {
                let diff = diff::read_with_patch(
                    git,
                    worktree,
                    repo_id.to_owned(),
                    repository_path,
                    file,
                    scope,
                )
                .await
                .map_err(ApiError::from_diff_error)?;
                digest.update(diff.document.revision.as_bytes());
            }
        } else {
            digest.update(b"clean\0");
        }
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

pub(super) async fn create_repository_shelf(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<ShelfCreateRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A shelf name, description, HEAD and selected file changes are required.",
        )
    })?;
    shelves::validate_metadata(&request.name, &request.description)
        .map_err(ApiError::from_shelf_error)?;
    if request.items.is_empty() || request.items.len() > 100 {
        return Err(ApiError::from_shelf_error(
            shelves::ShelfError::EmptySelection,
        ));
    }
    let shelf_scope = request.items[0].scope;
    if request.items.iter().any(|item| item.scope != shelf_scope) {
        return Err(ApiError::from_shelf_error(shelves::ShelfError::MixedScopes));
    }
    let repository = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    if repository.head != request.expected_head_oid {
        return Err(ApiError::from_staging_error(
            staging::StagingError::StaleSelection,
        ));
    }
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    prepare_shelf_items(
        &state.git_commands,
        state.diff_worktree.as_ref(),
        &state.status,
        &repo_id,
        &target.repository_path,
        &request.items,
    )
    .await?;
    let repositories = state.repositories.clone();
    let shelf_store = state.shelf_store.clone();
    let status_service = state.status.clone();
    let commands = state.git_commands.clone();
    let diff_worktree = state.diff_worktree.clone();
    let task_repo_id = repo_id.clone();
    let task_path = target.repository_path;
    let resource_key = target.resource_key;
    let expected_head_oid = request.expected_head_oid;
    let items = request.items;
    let name = request.name.trim().to_owned();
    let description = request.description;
    let task = state
        .tasks
        .submit(
            Some(repo_id.clone()),
            None,
            resource_key,
            "shelfCreate",
            move |context| async move {
                let current_repository = repositories
                    .refresh_metadata(&task_repo_id)
                    .await
                    .map_err(|_| TaskFailure::command_failed("Could not recheck the repository HEAD before creating the shelf.".into()))?;
                if current_repository.head != expected_head_oid {
                    return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "The repository HEAD changed after shelf review. Refresh the selected diffs and try again."));
                }
                let prepared = prepare_shelf_items(&commands, diff_worktree.as_ref(), &status_service, &task_repo_id, &task_path, &items)
                    .await
                    .map_err(|_| TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "The selected changes changed after shelf review. Refresh and select them again."))?;
                super::saving::save_prepared(prepared, super::saving::ShelfSaveMetadata {
                    shelf_id: shelves::new_shelf_id(), repo_id: task_repo_id,
                    name, description, head_oid: expected_head_oid, journal: None,
                }, shelf_store, move |operation| {
                    let commands = commands.clone();
                    let task_path = task_path.clone();
                    let context = context.clone();
                    async move { commands.execute_staging(&task_path, operation, context).await }
                }).await?;
                Ok(Some("Selected changes were saved to a shelf and removed from the working tree.".into()))
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn prepare_shelf_items<R: RepositoryPathPort, G: StatusReadPort>(
    git: &impl DiffGitPort,
    worktree: &dyn DiffWorktreePort,
    status_service: &super::super::status::StatusService<R, G>,
    repo_id: &str,
    repository_path: &std::path::Path,
    items: &[ShelfSelectionRequest],
) -> Result<PreparedShelf, ApiError> {
    let snapshot = status_service
        .snapshot(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let selections = items
        .iter()
        .map(|item| ShelfSelection {
            path: item.path.clone(),
            scope: item.scope.into(),
            revision: item.revision.clone(),
            selections: item.selections.iter().cloned().map(Into::into).collect(),
        })
        .collect::<Vec<_>>();
    preparation::prepare_items(
        git,
        worktree,
        repo_id,
        repository_path,
        &snapshot.files,
        &selections,
    )
    .await
    .map_err(|error| match error {
        PreparationError::Shelf(error) => ApiError::from_shelf_error(error),
        PreparationError::Diff(error) => ApiError::from_diff_error(error),
        PreparationError::StaleSelection => {
            ApiError::from_staging_error(staging::StagingError::StaleSelection)
        }
    })
}
