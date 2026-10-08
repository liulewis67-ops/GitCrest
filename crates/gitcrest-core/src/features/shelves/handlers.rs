use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};
use sha2::{Digest, Sha256};

use super::dto::{
    ShelfApplyPreviewResponse, ShelfApplyRequest, ShelfCreateRequest, ShelfDetailResponse,
    ShelfSelectionRequest,
};
use crate::{
    api::error::{ApiError, ApiErrorCode},
    features::diff::{self, DiffError, DiffScope},
    features::tasks::{TaskFailure, TaskSnapshot},
    features::{shelves, staging},
    repository::RepositoryManager,
    state::AppState,
    status,
    storage::{UndoOperation, UndoRecord},
};
#[derive(Clone)]
struct PreparedShelfItem {
    path: String,
    scope: DiffScope,
    patch: Vec<u8>,
}

pub(super) async fn list_repository_shelves(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<Vec<shelves::ShelfSnapshot>>, ApiError> {
    state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let store = state.repositories.store();
    let shelves = tokio::task::spawn_blocking(move || store.list_shelves(&repo_id))
        .await
        .map_err(|_| ApiError::task_storage_unavailable())?
        .map_err(|_| ApiError::task_storage_unavailable())?;
    Ok(Json(shelves))
}

pub(super) async fn get_repository_shelf(
    State(state): State<AppState>,
    Path((repo_id, shelf_id)): Path<(String, String)>,
) -> Result<Json<ShelfDetailResponse>, ApiError> {
    state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let store = state.repositories.store();
    let shelf = tokio::task::spawn_blocking(move || store.get_shelf(&repo_id, &shelf_id))
        .await
        .map_err(|_| ApiError::task_storage_unavailable())?
        .map_err(|_| ApiError::task_storage_unavailable())?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::ShelfNotFound,
                "This shelf is no longer available.",
            )
        })?;
    let patch = String::from_utf8(shelf.patch).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::InternalError,
            "The saved shelf preview could not be decoded.",
        )
    })?;
    Ok(Json(ShelfDetailResponse {
        shelf: shelf.snapshot,
        patch,
    }))
}

pub(super) async fn delete_repository_shelf(
    State(state): State<AppState>,
    Path((repo_id, shelf_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let store = state.repositories.store();
    let deleted = tokio::task::spawn_blocking(move || store.delete_shelf(&repo_id, &shelf_id))
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
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let repository = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let shelf = load_shelf_record(&state.repositories, &repo_id, &shelf_id).await?;
    let scope = shelf.snapshot.scope.ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::ResourceVersionStale,
            "This shelf predates scope metadata and cannot be applied automatically.",
        )
    })?;
    let preview_revision = shelf_apply_revision(
        &state.repositories,
        &repo_id,
        &target.repository_path,
        &shelf,
        repository.head.as_deref(),
    )
    .await?;
    let can_apply_cleanly = shelves::check_apply(&target.repository_path, &shelf.patch, scope)
        .await
        .map_err(ApiError::from_shelf_error)?;
    let can_apply_with_conflicts = !can_apply_cleanly
        && can_shelf_apply_with_conflicts(
            &state.repositories,
            &repo_id,
            &shelf,
            repository.head.as_deref(),
        )
        .await?;
    Ok(Json(ShelfApplyPreviewResponse {
        shelf: shelf.snapshot,
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
        .repositories
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
    let shelf = load_shelf_record(&state.repositories, &repo_id, &shelf_id).await?;
    let scope = shelf.snapshot.scope.ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::ResourceVersionStale,
            "This shelf predates scope metadata and cannot be applied automatically.",
        )
    })?;
    let current_revision = shelf_apply_revision(
        &state.repositories,
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
    let commands = state.git_commands.clone();
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
                    .map_err(|_| TaskFailure::Failed("Could not recheck repository HEAD before applying the shelf.".into()))?;
                if current_repository.head != expected_head_oid {
                    return Err(TaskFailure::Failed("Repository HEAD changed after shelf preview. Preview the shelf again.".into()));
                }
                let current_shelf = load_shelf_record(&repositories, &task_repo_id, &task_shelf_id)
                    .await
                    .map_err(|_| TaskFailure::Failed("The reviewed shelf is no longer available.".into()))?;
                let current_scope = current_shelf.snapshot.scope.ok_or_else(|| TaskFailure::Failed("This shelf has no safe restore scope.".into()))?;
                if current_scope != expected_scope {
                    return Err(TaskFailure::Failed("The shelf restore scope changed after preview. Preview it again.".into()));
                }
                let current_revision = shelf_apply_revision(
                    &repositories,
                    &task_repo_id,
                    &task_path,
                    &current_shelf,
                    current_repository.head.as_deref(),
                )
                .await
                .map_err(|_| TaskFailure::Failed("Could not recheck the shelf target state. Preview it again.".into()))?;
                if current_revision != preview_revision {
                    return Err(TaskFailure::Failed("The working tree changed after shelf preview. Preview the shelf again.".into()));
                }
                let can_apply = shelves::check_apply(&task_path, &patch, current_scope)
                    .await
                    .map_err(|_| TaskFailure::Failed("Git could not recheck the reviewed shelf patch.".into()))?;
                let clean_apply = if can_apply {
                    commands
                        .execute_staging(&task_path, shelves::restore_command(patch.clone(), current_scope), context.clone())
                        .await?;
                    true
                } else {
                    let can_resolve_conflicts = can_shelf_apply_with_conflicts(
                        &repositories,
                        &task_repo_id,
                        &current_shelf,
                        current_repository.head.as_deref(),
                    )
                    .await
                    .map_err(|_| TaskFailure::Failed("Could not verify that the shelf can enter conflict review.".into()))?;
                    if !can_resolve_conflicts {
                        return Err(TaskFailure::Failed("The shelf conflicts with the current branch and cannot be merged safely. No changes were applied; the shelf is still available.".into()));
                    }
                    match commands
                        .execute_staging(&task_path, shelves::restore_three_way_command(patch.clone()), context.clone())
                        .await
                    {
                        Ok(()) => {
                            commands
                                .execute_staging(&task_path, shelves::unstage_paths_command(&current_shelf.snapshot.paths), context.clone())
                                .await?;
                        }
                        Err(TaskFailure::Failed(message)) | Err(TaskFailure::WaitingForInput(message)) => {
                            let status = repositories
                                .status_snapshot(&task_repo_id)
                                .await
                                .map_err(|_| TaskFailure::Failed("Git reported an apply failure and conflict state could not be inspected. The shelf was retained.".into()))?;
                            if status.files.iter().any(|file| file.kind == status::ChangeKind::Conflicted && current_shelf.snapshot.paths.contains(&file.path)) {
                                return Err(TaskFailure::WaitingForInput("The shelf has conflicts. Resolve the affected files, then continue to keep the changes unstaged.".into()));
                            }
                            return Err(TaskFailure::Failed(format!("{message}. The shelf was retained.")));
                        }
                        Err(TaskFailure::Cancelled) => return Err(TaskFailure::Cancelled),
                    }
                    false
                };
                if clean_apply {
                    let undo_record = UndoRecord {
                        operation_task_id: context.task_id().to_owned(),
                        repo_id: task_repo_id.clone(),
                        created_at_ms: shelves::now_ms(),
                        reverse_patch: patch.clone(),
                        operation: UndoOperation::ShelfApply {
                            scope: current_scope,
                        },
                        restore_shelf: Some(current_shelf.snapshot.clone()),
                        restore_shelf_patch: Some(current_shelf.patch.clone()),
                    };
                    let store = repositories.store();
                    tokio::task::spawn_blocking(move || store.save_undo_record(&undo_record))
                        .await
                        .map_err(|_| TaskFailure::Failed("The shelf was applied, but its undo record could not be saved. The shelf entry was retained.".into()))?
                        .map_err(|_| TaskFailure::Failed("The shelf was applied, but its undo record could not be saved. The shelf entry was retained.".into()))?;
                }
                let store = repositories.store();
                let delete_repo_id = task_repo_id.clone();
                let delete_task_shelf_id = task_shelf_id.clone();
                let deletion = tokio::task::spawn_blocking(move || store.delete_shelf(&delete_repo_id, &delete_task_shelf_id))
                    .await
                    .map_err(|_| "The shelf was applied, but its saved entry could not be removed. Verify the working tree before retrying.".to_owned())
                    .and_then(|result| result.map_err(|_| "The shelf was applied, but its saved entry could not be removed. Verify the working tree before retrying.".to_owned()));
                if deletion != Ok(true) {
                    if clean_apply {
                        let store = repositories.store();
                        let repo_id = task_repo_id.clone();
                        let operation_task_id = context.task_id().to_owned();
                        let _ = tokio::task::spawn_blocking(move || {
                            store.delete_undo_record(&repo_id, &operation_task_id)
                        })
                        .await;
                    }
                    return Err(TaskFailure::Failed("The shelf was applied, but its saved entry could not be removed. Verify the working tree before retrying.".into()));
                }
                Ok(Some("The reviewed shelf was applied and removed from the saved shelf list.".into()))
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(crate) async fn load_shelf_record(
    repositories: &RepositoryManager,
    repo_id: &str,
    shelf_id: &str,
) -> Result<shelves::ShelfRecord, ApiError> {
    let store = repositories.store();
    let repo_id = repo_id.to_owned();
    let shelf_id = shelf_id.to_owned();
    tokio::task::spawn_blocking(move || store.get_shelf(&repo_id, &shelf_id))
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

async fn can_shelf_apply_with_conflicts(
    repositories: &RepositoryManager,
    repo_id: &str,
    shelf: &shelves::ShelfRecord,
    head_oid: Option<&str>,
) -> Result<bool, ApiError> {
    let Some(scope @ (DiffScope::WorkingTree | DiffScope::Index)) = shelf.snapshot.scope else {
        return Ok(false);
    };
    if head_oid.is_none() {
        return Ok(false);
    }
    let Some(repository) = repositories
        .get(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?
    else {
        return Ok(false);
    };
    if repository.state != "normal" {
        return Ok(false);
    }
    let status = repositories
        .status_snapshot(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    if status
        .files
        .iter()
        .any(|file| file.kind == status::ChangeKind::Conflicted)
    {
        return Ok(false);
    }
    Ok(shelf.snapshot.paths.iter().all(|path| {
        status
            .files
            .iter()
            .find(|file| file.path == *path)
            .is_none_or(|file| {
                file.kind != status::ChangeKind::Conflicted
                    && match scope {
                        DiffScope::WorkingTree => {
                            !file.categories.contains(&status::ChangeCategory::Staged)
                        }
                        DiffScope::Index => {
                            !file.categories.contains(&status::ChangeCategory::Unstaged)
                                && !file.categories.contains(&status::ChangeCategory::Untracked)
                        }
                        DiffScope::Commit => false,
                    }
            })
    }))
}

async fn shelf_apply_revision(
    repositories: &RepositoryManager,
    repo_id: &str,
    repository_path: &std::path::Path,
    shelf: &shelves::ShelfRecord,
    head_oid: Option<&str>,
) -> Result<String, ApiError> {
    let status = repositories
        .status_snapshot(repo_id)
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
            if file.kind == status::ChangeKind::Conflicted {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    ApiErrorCode::WorkflowNoActiveOperation,
                    "Resolve existing conflicts before previewing a shelf for this file.",
                ));
            }
            for scope in [DiffScope::Index, DiffScope::WorkingTree] {
                let diff = diff::read_with_patch(repo_id.to_owned(), repository_path, file, scope)
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
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let prepared = prepare_shelf_items(
        &state.repositories,
        &repo_id,
        &target.repository_path,
        &request.items,
    )
    .await?;
    let mut patch_bytes = Vec::new();
    let mut paths = prepared
        .iter()
        .map(|item| item.path.clone())
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    for item in &prepared {
        patch_bytes.extend_from_slice(&item.patch);
        if patch_bytes.last() != Some(&b'\n') {
            patch_bytes.push(b'\n');
        }
        if patch_bytes.len() > shelves::MAX_PATCH_BYTES {
            return Err(ApiError::from_shelf_error(
                shelves::ShelfError::PatchTooLarge,
            ));
        }
    }
    shelves::validate_patch(&patch_bytes, &paths).map_err(ApiError::from_shelf_error)?;

    let repositories = state.repositories.clone();
    let commands = state.git_commands.clone();
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
                    .map_err(|_| TaskFailure::Failed("Could not recheck the repository HEAD before creating the shelf.".into()))?;
                if current_repository.head != expected_head_oid {
                    return Err(TaskFailure::Failed("The repository HEAD changed after shelf review. Refresh the selected diffs and try again.".into()));
                }
                let prepared = prepare_shelf_items(&repositories, &task_repo_id, &task_path, &items)
                    .await
                    .map_err(|_| TaskFailure::Failed("The selected changes changed after shelf review. Refresh and select them again.".into()))?;
                let mut patch = Vec::new();
                let mut paths = prepared.iter().map(|item| item.path.clone()).collect::<Vec<_>>();
                paths.sort();
                paths.dedup();
                for item in &prepared {
                    patch.extend_from_slice(&item.patch);
                    if patch.last() != Some(&b'\n') { patch.push(b'\n'); }
                    if patch.len() > shelves::MAX_PATCH_BYTES {
                        return Err(TaskFailure::Failed("The selected shelf changes exceed the 10 MiB limit.".into()));
                    }
                }
                shelves::validate_patch(&patch, &paths)
                    .map_err(|_| TaskFailure::Failed("Select at least one text change to shelve.".into()))?;
                for item in &prepared {
                    for (_scope, command) in shelves::check_commands(item.patch.clone(), item.scope) {
                        commands.execute_staging(&task_path, command, context.clone()).await?;
                    }
                }

                let shelf = shelves::ShelfRecord {
                    snapshot: shelves::ShelfSnapshot {
                        shelf_id: shelves::new_shelf_id(),
                        repo_id: task_repo_id.clone(),
                        name,
                        description,
                        paths,
                        scope: Some(shelf_scope),
                        head_oid: expected_head_oid,
                        created_at_ms: shelves::now_ms(),
                    },
                    patch,
                };
                let store = repositories.store();
                let persisted = shelf.clone();
                tokio::task::spawn_blocking(move || store.save_shelf(&persisted))
                    .await
                    .map_err(|_| TaskFailure::Failed("Could not persist the shelf before changing the working tree.".into()))?
                    .map_err(|_| TaskFailure::Failed("Could not persist the shelf before changing the working tree.".into()))?;

                let mut applied = Vec::<(Vec<u8>, DiffScope)>::new();
                for item in &prepared {
                    for (scope, command) in shelves::cleanup_commands(item.patch.clone(), item.scope) {
                        match commands.execute_staging(&task_path, command, context.clone()).await {
                            Ok(()) => applied.push((item.patch.clone(), scope)),
                            Err(TaskFailure::Cancelled) => return Err(TaskFailure::Cancelled),
                            Err(TaskFailure::Failed(message)) | Err(TaskFailure::WaitingForInput(message)) => {
                                let mut restored = true;
                                for (patch, scope) in applied.iter().rev() {
                                    if commands.execute_staging(&task_path, shelves::rollback_command(patch.clone(), *scope), context.clone()).await.is_err() {
                                        restored = false;
                                        break;
                                    }
                                }
                                if restored {
                                    let store = repositories.store();
                                    let shelf_id = shelf.snapshot.shelf_id.clone();
                                    let repo_id = task_repo_id.clone();
                                    let _ = tokio::task::spawn_blocking(move || store.delete_shelf(&repo_id, &shelf_id)).await;
                                }
                                return Err(TaskFailure::Failed(if restored { message } else { format!("{message}. The saved shelf was retained so the selected changes can be recovered.") }));
                            }
                        }
                    }
                }
                Ok(Some("Selected changes were saved to a shelf and removed from the working tree.".into()))
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn prepare_shelf_items(
    repositories: &RepositoryManager,
    repo_id: &str,
    repository_path: &std::path::Path,
    items: &[ShelfSelectionRequest],
) -> Result<Vec<PreparedShelfItem>, ApiError> {
    let mut paths = std::collections::HashSet::new();
    let snapshot = repositories
        .status_snapshot(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let mut prepared = Vec::with_capacity(items.len());
    for item in items {
        if item.scope == DiffScope::Commit || !paths.insert(item.path.as_str()) {
            return Err(ApiError::from_shelf_error(
                shelves::ShelfError::EmptySelection,
            ));
        }
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == item.path)
            .ok_or_else(|| ApiError::from_staging_error(staging::StagingError::StaleSelection))?;
        let current = diff::read_with_patch(repo_id.to_owned(), repository_path, file, item.scope)
            .await
            .map_err(ApiError::from_diff_error)?;
        if current.document.revision != item.revision {
            return Err(ApiError::from_staging_error(
                staging::StagingError::StaleSelection,
            ));
        }
        if current.document.status != diff::DiffContentStatus::Text {
            return Err(ApiError::from_shelf_error(
                shelves::ShelfError::EmptySelection,
            ));
        }
        let patch = if item.selections.is_empty() {
            current.patch
        } else {
            diff::select_changes(&current, &item.selections).map_err(|error| {
                if error == DiffError::InvalidPath {
                    ApiError::from_shelf_error(shelves::ShelfError::EmptySelection)
                } else {
                    ApiError::from_diff_error(error)
                }
            })?
        };
        shelves::validate_patch(&patch, std::slice::from_ref(&item.path))
            .map_err(ApiError::from_shelf_error)?;
        if std::str::from_utf8(&patch).is_err() {
            return Err(ApiError::from_shelf_error(
                shelves::ShelfError::EmptySelection,
            ));
        }
        prepared.push(PreparedShelfItem {
            path: item.path.clone(),
            scope: item.scope,
            patch,
        });
    }
    Ok(prepared)
}
