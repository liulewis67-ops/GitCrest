use std::path::Path as FilePath;

use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::{
        diff::DiffScope,
        staging::{ShelfPatchAction, StagingOperation},
        time::unix_time_ms,
        undo::{UndoOperation, UndoRecord},
    },
    features::diff::{self, DiffError},
    features::staging,
    features::tasks::{self, TaskFailure, TaskSnapshot},
    git::command::GitCommandService,
    state::AppState,
    storage::RepositoryStore,
};
pub(crate) async fn stage_repository(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<staging::StagingRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A staging action request is required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = state
        .status
        .snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    staging::command(&snapshot, &request).map_err(ApiError::from_staging_error)?;

    let action = request.action;
    let operation = match action {
        staging::StagingAction::StageFile => "stageFile",
        staging::StagingAction::UnstageFile => "unstageFile",
        staging::StagingAction::StageAll => "stageAll",
        staging::StagingAction::UnstageAll => "unstageAll",
    };
    let repositories = state.repositories.clone();
    let status_service = state.status.clone();
    let store = repositories.store();
    let commands = state.git_commands.clone();
    let task_repo_id = repo_id.clone();
    let repository_path = target.repository_path;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            operation,
            move |context| async move {
                let current = status_service.snapshot(&task_repo_id).await.map_err(|_| {
                    TaskFailure::Failed("Could not refresh repository status before staging".into())
                })?;
                let command = staging::command(&current, &request).map_err(|error| {
                    TaskFailure::Failed(format!("Staging precondition changed: {error:?}"))
                })?;
                let before_tree = match commands.read_index_tree(&repository_path).await {
                    Ok(tree) => Some(tree),
                    Err(_) => {
                        context
                            .log(
                                "Undo is unavailable because the Git index has unresolved entries.",
                            )
                            .await;
                        None
                    }
                };
                commands
                    .execute_staging(&repository_path, command, context.clone())
                    .await?;
                persist_staging_undo(
                    &commands,
                    &store,
                    &repository_path,
                    &task_repo_id,
                    before_tree,
                    context,
                )
                .await;
                Ok(None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(crate) async fn stage_repository_patch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<staging::StagingPatchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A partial staging selection is required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = state
        .status
        .snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let file = snapshot
        .files
        .iter()
        .find(|file| file.path == request.path)
        .ok_or_else(|| ApiError::from_staging_error(staging::StagingError::StaleSelection))?;
    let current_diff = diff::read_with_patch(
        &state.git_commands,
        repo_id.clone(),
        &target.repository_path,
        file,
        request.scope.into(),
    )
    .await
    .map_err(ApiError::from_diff_error)?;
    if current_diff.document.revision != request.revision {
        return Err(ApiError::from_staging_error(
            staging::StagingError::StaleSelection,
        ));
    }
    staging::validate_patch_request(&request, file).map_err(ApiError::from_staging_error)?;
    let diff_selections = request
        .selections
        .iter()
        .cloned()
        .map(Into::into)
        .collect::<Vec<_>>();
    let _ = diff::select_changes(&current_diff, &diff_selections).map_err(|error| {
        if error == DiffError::InvalidPath {
            ApiError::from_staging_error(staging::StagingError::InvalidRequest)
        } else {
            ApiError::from_diff_error(error)
        }
    })?;

    let action = request.action;
    let operation = match action {
        staging::StagingPatchAction::Stage => "stageHunks",
        staging::StagingPatchAction::Unstage => "unstageHunks",
    };
    let repositories = state.repositories.clone();
    let status_service = state.status.clone();
    let store = repositories.store();
    let commands = state.git_commands.clone();
    let task_repo_id = repo_id.clone();
    let repository_path = target.repository_path;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            operation,
            move |context| async move {
                let current = status_service.snapshot(&task_repo_id).await.map_err(|_| {
                    TaskFailure::Failed(
                        "Could not refresh repository status before partial staging".into(),
                    )
                })?;
                let file = current
                    .files
                    .iter()
                    .find(|file| file.path == request.path)
                    .ok_or_else(|| {
                        TaskFailure::Failed(
                            "The selected file changed before partial staging".into(),
                        )
                    })?;
                staging::validate_patch_request(&request, file).map_err(|_| {
                    TaskFailure::Failed(
                        "The selected file state changed before partial staging".into(),
                    )
                })?;
                let current_diff = diff::read_with_patch(
                    &commands,
                    task_repo_id.clone(),
                    &repository_path,
                    file,
                    request.scope.into(),
                )
                .await
                .map_err(|_| {
                    TaskFailure::Failed(
                        "Could not refresh the selected diff before partial staging".into(),
                    )
                })?;
                if current_diff.document.revision != request.revision {
                    return Err(TaskFailure::Failed(
                        "The selected diff became stale; refresh and select changes again".into(),
                    ));
                }
                let diff_selections = request
                    .selections
                    .iter()
                    .cloned()
                    .map(Into::into)
                    .collect::<Vec<_>>();
                let selected_patch = diff::select_changes(&current_diff, &diff_selections)
                    .map_err(|_| {
                        TaskFailure::Failed("The selected diff hunk is no longer available".into())
                    })?;
                let before_tree = match commands.read_index_tree(&repository_path).await {
                    Ok(tree) => Some(tree),
                    Err(_) => {
                        context
                            .log(
                                "Undo is unavailable because the Git index has unresolved entries.",
                            )
                            .await;
                        None
                    }
                };
                commands
                    .execute_staging(
                        &repository_path,
                        staging::patch_command(action, selected_patch),
                        context.clone(),
                    )
                    .await?;
                persist_staging_undo(
                    &commands,
                    &store,
                    &repository_path,
                    &task_repo_id,
                    before_tree,
                    context,
                )
                .await;
                Ok(None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(crate) async fn undo_recent_operation(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let store = state.repositories.store();
    if store
        .latest_undo_record(&repo_id)
        .map_err(|_| ApiError::task_storage_unavailable())?
        .is_none()
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::RepositoryStateConflict,
            "There is no recent operation available to undo.",
        ));
    }
    let task_repo_id = repo_id.clone();
    let task_store = store.clone();
    let shelf_store = state.shelf_store.clone();
    let commands = state.git_commands.clone();
    let repository_path = target.repository_path;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "undoRecentOperation",
            move |context| async move {
                let record = task_store
                    .latest_undo_record(&task_repo_id)
                    .map_err(|_| {
                        TaskFailure::Failed("Could not load the recent undo record".into())
                    })?
                    .ok_or_else(|| {
                        TaskFailure::Failed(
                            "There is no recent operation available to undo".into(),
                        )
                })?;
                let undo_patch = record.reverse_patch.clone();
                let shelf_already_restored = if let Some(snapshot) = record.restore_shelf.as_ref() {
                    let repo_id = task_repo_id.clone();
                    let shelf_id = snapshot.shelf_id.clone();
                    let shelf_store_for_read = shelf_store.clone();
                    let existing = tokio::task::spawn_blocking(move || shelf_store_for_read.read_shelf_record(&repo_id, &shelf_id))
                        .await
                        .map_err(|_| TaskFailure::Failed("Could not verify the saved shelf state before undo.".into()))?
                        .map_err(|_| TaskFailure::Failed("Could not verify the saved shelf state before undo.".into()))?;
                    match existing {
                        Some(existing) if existing.snapshot == *snapshot && existing.patch.as_slice() == record.restore_shelf_patch.as_deref().unwrap_or(undo_patch.as_slice()) => true,
                        Some(_) => return Err(TaskFailure::Failed("A different saved shelf already uses the identifier needed to undo this operation. Resolve the shelf list before retrying.".into())),
                        None => false,
                    }
                } else {
                    false
                };
                if !shelf_already_restored {
                    commands
                        .execute_staging(
                            &repository_path,
                            match record.operation {
                                UndoOperation::Staging => staging::undo_command(undo_patch.clone()),
                            UndoOperation::ShelfApply { scope } => StagingOperation::ApplyShelfPatch {
                                patch: undo_patch.clone(),
                                scope,
                                action: ShelfPatchAction::UndoRestore,
                            },
                            UndoOperation::WorkspaceDiscard => {
                                staging::undo_discard_command(undo_patch.clone())
                            }
                            },
                            context.clone(),
                        )
                        .await
                        .map_err(|_| {
                            TaskFailure::Failed(
                                "Git could not safely apply this undo patch. The working tree or index may have changed; refresh and review it before trying again.".into(),
                            )
                        })?;
                }
                if let Some(snapshot) = record.restore_shelf {
                    if !shelf_already_restored {
                    let shelf = crate::domain::shelf::ShelfRecord {
                        snapshot,
                        patch: record.restore_shelf_patch.unwrap_or(undo_patch),
                    };
                    let shelf_store_for_save = shelf_store.clone();
                    tokio::task::spawn_blocking(move || shelf_store_for_save.save_shelf_record(shelf))
                        .await
                        .map_err(|_| TaskFailure::Failed("The shelf changes were undone, but the saved shelf entry could not be restored. The undo record was retained.".into()))?
                        .map_err(|_| TaskFailure::Failed("The shelf changes were undone, but the saved shelf entry could not be restored. The undo record was retained.".into()))?;
                    }
                }
                if task_store
                    .delete_undo_record(&task_repo_id, &record.operation_task_id)
                    .is_err()
                {
                    context
                        .log("The operation was undone, but its undo record could not be removed.")
                        .await;
                }
                Ok(None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn persist_staging_undo(
    commands: &GitCommandService,
    store: &RepositoryStore,
    repository_path: &FilePath,
    repo_id: &str,
    before_tree: Option<String>,
    context: tasks::TaskContext,
) {
    let Some(before_tree) = before_tree else {
        return;
    };
    let result = async {
        let after_tree = commands.read_index_tree(repository_path).await?;
        if before_tree == after_tree {
            return Ok(());
        }
        let reverse_patch = commands
            .diff_index_trees(repository_path, &after_tree, &before_tree)
            .await?;
        if reverse_patch.is_empty() {
            return Ok(());
        }
        store
            .save_undo_record(&UndoRecord {
                operation_task_id: context.task_id().to_owned(),
                repo_id: repo_id.to_owned(),
                created_at_ms: unix_time_ms(),
                reverse_patch,
                operation: UndoOperation::Staging,
                restore_shelf: None,
                restore_shelf_patch: None,
            })
            .map_err(|_| TaskFailure::Failed("The undo snapshot could not be saved".into()))
    }
    .await;
    if result.is_err() {
        context
            .log("This staging operation completed, but its undo data could not be saved.")
            .await;
    }
}

pub(crate) async fn discard_repository_patch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<staging::DiscardPatchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A selected working-tree diff and confirmation are required.",
        )
    })?;
    if !request.confirm_discard {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Discarding working-tree changes requires explicit confirmation.",
        ));
    }
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = state
        .status
        .snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let file = snapshot
        .files
        .iter()
        .find(|file| file.path == request.path)
        .ok_or_else(|| ApiError::from_staging_error(staging::StagingError::StaleSelection))?;
    let selection = staging::StagingPatchRequest {
        action: staging::StagingPatchAction::Stage,
        path: request.path.clone(),
        scope: staging::StagingDiffScope::WorkingTree,
        revision: request.revision.clone(),
        selections: request.selections.clone(),
    };
    staging::validate_patch_request(&selection, file).map_err(ApiError::from_staging_error)?;
    let current_diff = diff::read_with_patch(
        &state.git_commands,
        repo_id.clone(),
        &target.repository_path,
        file,
        DiffScope::WorkingTree,
    )
    .await
    .map_err(ApiError::from_diff_error)?;
    if current_diff.document.revision != request.revision {
        return Err(ApiError::from_staging_error(
            staging::StagingError::StaleSelection,
        ));
    }
    let diff_selections = request
        .selections
        .iter()
        .cloned()
        .map(Into::into)
        .collect::<Vec<_>>();
    let _ = diff::select_changes(&current_diff, &diff_selections).map_err(|error| {
        if error == DiffError::InvalidPath {
            ApiError::from_staging_error(staging::StagingError::InvalidRequest)
        } else {
            ApiError::from_diff_error(error)
        }
    })?;
    let repositories = state.repositories.clone();
    let status_service = state.status.clone();
    let commands = state.git_commands.clone();
    let task_repo_id = repo_id.clone();
    let repository_path = target.repository_path;
    let path = request.path;
    let revision = request.revision;
    let selection_dtos = request.selections;
    let selections = selection_dtos
        .iter()
        .cloned()
        .map(Into::into)
        .collect::<Vec<_>>();
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "discardChanges",
            move |context| async move {
                let current = status_service
                    .snapshot(&task_repo_id)
                    .await
                    .map_err(|_| {
                        TaskFailure::Failed(
                            "Could not refresh repository status before discarding changes".into(),
                        )
                    })?;
                let file = current
                    .files
                    .iter()
                    .find(|file| file.path == path)
                    .ok_or_else(|| {
                        TaskFailure::Failed(
                            "The selected file changed before discarding its changes".into(),
                        )
                    })?;
                let selection = staging::StagingPatchRequest {
                    action: staging::StagingPatchAction::Stage,
                    path: path.clone(),
                    scope: staging::StagingDiffScope::WorkingTree,
                    revision: revision.clone(),
                    selections: selection_dtos.clone(),
                };
                staging::validate_patch_request(&selection, file).map_err(|_| {
                    TaskFailure::Failed(
                        "The selected working-tree file state changed before discard".into(),
                    )
                })?;
                let current_diff = diff::read_with_patch(
                    &commands,
                    task_repo_id.clone(),
                    &repository_path,
                    file,
                    DiffScope::WorkingTree,
                )
                .await
                .map_err(|_| {
                    TaskFailure::Failed(
                        "Could not refresh the selected diff before discarding changes".into(),
                    )
                })?;
                if current_diff.document.revision != revision {
                    return Err(TaskFailure::Failed(
                        "The selected diff became stale; refresh and review it again".into(),
                    ));
                }
                let patch = diff::select_changes(&current_diff, &selections).map_err(|_| {
                    TaskFailure::Failed("The selected diff change is no longer available".into())
                })?;
                commands
                    .execute_staging(
                        &repository_path,
                        staging::discard_patch_command(patch.clone()),
                        context.clone(),
                    )
                    .await
                    ?;
                let store = repositories.store();
                if store
                    .save_undo_record(&UndoRecord {
                        operation_task_id: context.task_id().to_owned(),
                        repo_id: task_repo_id.clone(),
                        created_at_ms: unix_time_ms(),
                        reverse_patch: patch,
                        operation: UndoOperation::WorkspaceDiscard,
                        restore_shelf: None,
                        restore_shelf_patch: None,
                    })
                    .is_err()
                {
                    context
                        .log("The selected changes were discarded, but their undo data could not be saved.")
                        .await;
                }
                Ok(None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
