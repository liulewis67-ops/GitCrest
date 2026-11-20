use crate::domain::git_result::GitFailureCode;
use axum::{
    extract::{rejection::JsonRejection, rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use super::local_files;
use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::{branch::BranchCommand, error::WorkflowError},
    features::branches,
    features::repositories::{Repository, TaskTarget},
    ports::git::GitReadPort,
    AppState, TaskFailure, TaskSnapshot,
};

use super::dto::{
    AddWorktreeRequest, BranchDeletePreview, BranchFavoriteRequest, BranchNameQuery,
    BranchNameRequest, BranchSwitchPreflight, CopyableFile, CopyableFiles, CreateBranchRequest,
    DeleteBranchRequest, RemoveWorktreeRequest, RenameBranchRequest, SwitchBranchRequest,
    WorktreeFolderCheck, WorktreeFolderQuery, WorktreeInfo, WorktreeSnapshot,
};

pub(super) async fn repository_branches(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<branches::BranchSnapshot>, ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = branches::read_branches_with_favorites(
        repo_id,
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        state.branch_git.as_ref(),
        state.branch_favorites.clone(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    Ok(Json(snapshot))
}

pub(super) async fn repository_worktrees(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<WorktreeSnapshot>, ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let entries = state
        .git_commands
        .list_worktrees(&target.repository_path)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::RequestInvalid,
                "Could not list the worktrees of this repository.",
            )
        })?;
    let current = std::fs::canonicalize(&target.repository_path).ok();
    // Dirty checks are independent `git status` runs, so they go out together.
    let mut checks = tokio::task::JoinSet::new();
    for (index, entry) in entries
        .into_iter()
        .enumerate()
        .filter(|(_, entry)| !entry.bare)
    {
        let is_current = current
            .as_ref()
            .zip(std::fs::canonicalize(&entry.path).ok())
            .is_some_and(|(left, right)| *left == right);
        let git_commands = state.git_commands.clone();
        checks.spawn(async move {
            let is_dirty = !entry.prunable
                && git_commands
                    .worktree_is_dirty(std::path::Path::new(&entry.path))
                    .await;
            (
                index,
                WorktreeInfo {
                    path: entry.path,
                    head: entry.head,
                    branch: entry.branch,
                    detached: entry.detached,
                    locked: entry.locked,
                    prunable: entry.prunable,
                    is_current,
                    is_main: index == 0,
                    is_dirty,
                },
            )
        });
    }
    let mut ordered = Vec::new();
    while let Some(result) = checks.join_next().await {
        if let Ok(item) = result {
            ordered.push(item);
        }
    }
    ordered.sort_by_key(|(index, _)| *index);
    let worktrees = ordered.into_iter().map(|(_, info)| info).collect();
    Ok(Json(WorktreeSnapshot { repo_id, worktrees }))
}

/// Lists small Git-ignored files (such as .env) that can be copied into a new worktree.
pub(super) async fn list_worktree_local_files(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<CopyableFiles>, ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let listing = local_files::list_copyable_files(&state.git_commands, &target.repository_path)
        .await
        .map_err(|()| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::RequestInvalid,
                "Could not list the local files of this repository.",
            )
        })?;
    Ok(Json(CopyableFiles {
        files: listing
            .files
            .into_iter()
            .map(|(path, size_bytes)| CopyableFile { path, size_bytes })
            .collect(),
        omitted_count: listing.omitted,
    }))
}

/// Rejects copy requests for anything that is not on the copyable list.
async fn validate_copy_files(
    state: &AppState,
    repository_path: &std::path::Path,
    requested: &[String],
) -> Result<(), ApiError> {
    let rejected =
        local_files::rejected_copy_requests(&state.git_commands, repository_path, requested)
            .await
            .map_err(|()| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ApiErrorCode::RequestInvalid,
                    "Could not check the files to copy.",
                )
            })?;
    if rejected.is_empty() {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Only small, Git-ignored files inside the repository can be copied.",
        ))
    }
}

/// Copies the chosen files into the new worktree and records the outcome in the task log.
async fn copy_into_worktree(
    context: &crate::execution::TaskContext,
    git: &crate::git::command::GitCommandService,
    directory: &Option<std::sync::Arc<crate::execution::write_access::DirectoryPermit>>,
    repository_path: std::path::PathBuf,
    folder: String,
    files: Vec<String>,
) {
    if files.is_empty() {
        return;
    }
    let rejected = match local_files::rejected_copy_requests(git, &repository_path, &files).await {
        Ok(rejected) => rejected,
        Err(()) => {
            context
                .log("Not copied: local file eligibility could not be verified.")
                .await;
            return;
        }
    };
    for path in &rejected {
        context
            .log(&format!(
                "Not copied: {path}: no longer an eligible ignored file."
            ))
            .await;
    }
    let files = files
        .into_iter()
        .filter(|path| !rejected.contains(path))
        .collect::<Vec<_>>();
    let directory = directory.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let _directory = directory;
        local_files::copy_files(&repository_path, std::path::Path::new(&folder), &files)
    })
    .await;
    match outcome {
        Ok((copied, failures)) => {
            context
                .log(&format!("Copied {copied} local file(s) into the worktree."))
                .await;
            for failure in failures {
                context.log(&format!("Not copied: {failure}")).await;
            }
        }
        Err(_) => context.log("Copying local files did not finish.").await,
    }
}

/// Tells whether a folder can receive a new worktree, so dialogs can warn before anything is submitted.
pub(super) async fn check_worktree_folder(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<WorktreeFolderQuery>, QueryRejection>,
) -> Result<Json<WorktreeFolderCheck>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A folder path is required.",
        )
    })?;
    state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let candidate = std::path::Path::new(&query.path);
    let status = if !candidate.is_absolute() {
        "notAbsolute"
    } else if candidate.is_file() {
        "isFile"
    } else if candidate
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
    {
        "notEmpty"
    } else {
        "ok"
    };
    Ok(Json(WorktreeFolderCheck { status }))
}

/// A new worktree folder must be an absolute path that does not exist yet or is empty.
fn validate_new_worktree_folder(worktree_path: &str) -> Result<(), ApiError> {
    let candidate = std::path::Path::new(worktree_path);
    let occupied = candidate
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or_else(|_| candidate.exists());
    if !candidate.is_absolute() || occupied {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The worktree path must be an absolute path to a new or empty folder.",
        ));
    }
    Ok(())
}

async fn worktree_directory_permit(
    context: &crate::execution::TaskContext,
    repo_id: &str,
    path: std::path::PathBuf,
) -> Result<
    (
        std::path::PathBuf,
        Option<std::sync::Arc<crate::execution::write_access::DirectoryPermit>>,
    ),
    TaskFailure,
> {
    let mut cancellation = context.clone();
    context.progress("Waiting for worktree access", None).await;
    let permit = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(TaskFailure::Cancelled),
        permit = context.directory_write_permit(repo_id, vec![path.clone()]) => permit.map_err(|error| {
            let message = match error {
                crate::execution::write_access::WriteAccessError::Owned { operation_id } =>
                    format!("Worktree folder is protected by operation {operation_id}"),
                _ => "Worktree folder write access could not be verified. Refresh and retry.".into(),
            };
            TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, message)
        }),
    }?;
    let resolved = permit
        .as_ref()
        .and_then(|permit| permit.paths.first())
        .cloned()
        .unwrap_or(path);
    Ok((resolved, permit.map(std::sync::Arc::new)))
}

/// Checks an existing local branch out into a new linked worktree.
pub(super) async fn add_repository_worktree(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<AddWorktreeRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A local branch and a worktree folder are required.",
        )
    })?;
    validate_new_worktree_folder(&request.path)?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let mut command = if request.from_remote {
        let Some((_, local_branch)) = request.branch.split_once('/') else {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "A remote branch looks like origin/feature.",
            ));
        };
        let references = state
            .branch_git
            .list_references(&target.repository_path)
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ApiErrorCode::RequestInvalid,
                    "Could not read the branches of this repository.",
                )
            })?;
        if !references
            .iter()
            .any(|reference| reference.full_name == format!("refs/remotes/{}", request.branch))
        {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RequestInvalid,
                "That remote branch is not available. Fetch and try again.",
            ));
        }
        branches::validate_branch_name_with_git(
            &target.repository_path,
            local_branch,
            state.branch_git.as_ref(),
        )
        .await
        .map_err(ApiError::from_branch_error)?;
        branches::ensure_local_branch_name_available_with_git(
            &target.repository_path,
            local_branch,
            state.branch_git.as_ref(),
        )
        .await
        .map_err(ApiError::from_branch_error)?;
        BranchCommand::WorktreeAddTracking {
            local_branch: local_branch.to_owned(),
            remote_ref: request.branch.clone(),
            path: request.path.clone(),
        }
    } else {
        branches::require_local_branch_with_git(
            &target.repository_path,
            &request.branch,
            state.branch_git.as_ref(),
        )
        .await
        .map_err(ApiError::from_branch_error)?;
        let entries = state
            .git_commands
            .list_worktrees(&target.repository_path)
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    ApiErrorCode::RequestInvalid,
                    "Could not list the worktrees of this repository.",
                )
            })?;
        if entries
            .iter()
            .any(|entry| entry.branch.as_deref() == Some(request.branch.as_str()))
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                ApiErrorCode::RequestInvalid,
                "That branch is already checked out in another worktree.",
            ));
        }
        BranchCommand::WorktreeAdd {
            branch: request.branch.clone(),
            path: request.path.clone(),
        }
    };
    validate_copy_files(&state, &target.repository_path, &request.copy_files).await?;
    let copy_list = request.copy_files;
    let path = target.repository_path;
    let copy_source = path.clone();
    let git_commands = state.git_commands.clone();
    let folder = request.path;
    let repositories = state.repositories.clone();
    let directory_repo_id = repo_id.clone();
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "worktreeCreate",
            move |context| async move {
                let resolved = crate::storage::repository_paths::canonicalize_prospective(
                    std::path::Path::new(&folder),
                )
                .await
                .map_err(|_| {
                    TaskFailure::diagnosed(
                        GitFailureCode::PreconditionChanged,
                        "Worktree folder identity could not be verified",
                    )
                })?;
                let (resolved, _directory) =
                    worktree_directory_permit(&context, &directory_repo_id, resolved).await?;
                let folder = resolved
                    .to_str()
                    .ok_or_else(|| {
                        TaskFailure::diagnosed(
                            GitFailureCode::PreconditionChanged,
                            "Worktree folder cannot be represented safely",
                        )
                    })?
                    .to_owned();
                validate_new_worktree_folder(&folder).map_err(|error| {
                    TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, error.message)
                })?;
                match &mut command {
                    BranchCommand::WorktreeAdd { path, .. }
                    | BranchCommand::WorktreeAddTracking { path, .. } => *path = folder.clone(),
                    _ => {
                        return Err(TaskFailure::diagnosed(
                            GitFailureCode::PreconditionChanged,
                            "Worktree creation request is no longer valid",
                        ))
                    }
                }
                let task_context = context.clone();
                git_commands.execute_branch(&path, command, context).await?;
                copy_into_worktree(
                    &task_context,
                    &git_commands,
                    &_directory,
                    copy_source,
                    folder.clone(),
                    copy_list,
                )
                .await;
                // Register the new worktree so the app can open it right away.
                Ok(repositories
                    .open_path(&folder)
                    .await
                    .ok()
                    .map(|repository| repository.repo_id))
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

/// Forgets worktrees whose folders were deleted outside Git, so their names and paths can be reused.
pub(super) async fn prune_repository_worktrees(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "worktreePrune",
            move |context| async move {
                command
                    .execute_branch(&path, BranchCommand::WorktreePrune, context)
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn remove_repository_worktree(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RemoveWorktreeRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A worktree path is required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let invalid = |message: &'static str| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            message,
        )
    };
    let entries = state
        .git_commands
        .list_worktrees(&target.repository_path)
        .await
        .map_err(|_| invalid("Could not list the worktrees of this repository."))?;
    let requested = std::fs::canonicalize(&request.path).ok();
    let current = std::fs::canonicalize(&target.repository_path).ok();
    let matched = entries.iter().enumerate().find(|(_, entry)| {
        entry.path == request.path
            || requested
                .as_ref()
                .zip(std::fs::canonicalize(&entry.path).ok())
                .is_some_and(|(left, right)| *left == right)
    });
    let Some((index, entry)) = matched else {
        return Err(invalid("That folder is not a worktree of this repository."));
    };
    if index == 0 {
        return Err(invalid("The main working tree cannot be removed."));
    }
    if current
        .as_ref()
        .zip(std::fs::canonicalize(&entry.path).ok())
        .is_some_and(|(left, right)| *left == right)
    {
        return Err(invalid("The worktree you are viewing cannot be removed."));
    }
    // The branch is checked before anything is removed, so a branch that cannot be deleted never
    // leaves the worktree gone and the branch behind.
    let branch_to_delete = if request.delete_branch {
        let Some(branch) = entry.branch.clone() else {
            return Err(invalid("This worktree has no branch to delete."));
        };
        let metadata = state
            .repositories
            .refresh_metadata(&repo_id)
            .await
            .map_err(ApiError::from_repository_error)?;
        branches::validate_branch_delete_with_git(
            &target.repository_path,
            metadata.branch.as_deref(),
            metadata.detached,
            &branch,
            request.allow_unmerged,
            state.branch_git.as_ref(),
        )
        .await
        .map_err(ApiError::from_branch_error)?;
        Some(branch)
    } else {
        None
    };
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let favorites_store = state.branch_favorites.clone();
    let repo_for_favorite = repo_id.clone();
    let worktree_path = entry.path.clone();
    let expected_head = entry.head.clone();
    let expected_branch = entry.branch.clone();
    let resource_reader = state.repository_targets.clone();
    let force = request.force;
    let allow_unmerged = request.allow_unmerged;
    let directory_repo_id = repo_id.clone();
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "worktreeRemove",
            move |context| async move {
                let resolved = crate::storage::repository_paths::canonicalize_prospective(
                    std::path::Path::new(&worktree_path),
                )
                .await
                .map_err(|_| {
                    TaskFailure::diagnosed(
                        GitFailureCode::PreconditionChanged,
                        "Worktree folder identity could not be verified",
                    )
                })?;
                let (resolved, _directory) =
                    worktree_directory_permit(&context, &directory_repo_id, resolved).await?;
                let changed = || {
                    TaskFailure::diagnosed(
                        GitFailureCode::PreconditionChanged,
                        "Worktree identity changed. Refresh and retry.",
                    )
                };
                let entries = command.list_worktrees(&path).await?;
                let mut registered = false;
                for (index, entry) in entries.iter().enumerate() {
                    let candidate = crate::storage::repository_paths::canonicalize_prospective(
                        std::path::Path::new(&entry.path),
                    )
                    .await
                    .map_err(|_| changed())?;
                    if candidate == resolved {
                        if index == 0
                            || entry.head != expected_head
                            || entry.branch != expected_branch
                        {
                            return Err(changed());
                        }
                        registered = true;
                        break;
                    }
                }
                if !registered {
                    return Err(changed());
                }
                if tokio::fs::try_exists(&resolved)
                    .await
                    .map_err(|_| changed())?
                {
                    use crate::ports::operations::OperationResourcePort;
                    let source = resource_reader
                        .operation_resource_key_for_path(&path)
                        .await
                        .map_err(|_| changed())?;
                    let destination = resource_reader
                        .operation_resource_key_for_path(&resolved)
                        .await
                        .map_err(|_| changed())?;
                    if source != destination {
                        return Err(changed());
                    }
                }
                let worktree_path = resolved
                    .to_str()
                    .ok_or_else(|| {
                        TaskFailure::diagnosed(
                            GitFailureCode::PreconditionChanged,
                            "Worktree folder cannot be represented safely",
                        )
                    })?
                    .to_owned();
                let removal = command
                    .execute_branch(
                        &path,
                        BranchCommand::WorktreeRemove {
                            path: worktree_path,
                            force,
                        },
                        context.clone(),
                    )
                    .await;
                if context.cancellation_requested() {
                    return Err(TaskFailure::Cancelled);
                }
                finish_worktree_removal(&command, &path, &resolved, force, removal).await?;
                let Some(name) = branch_to_delete else {
                    return Ok(None);
                };
                let favorite_mutation = branches::BranchFavoriteMutation::Remove {
                    full_name: format!("refs/heads/{name}"),
                };
                branches::execute_branch_and_update_favorites(
                    repo_for_favorite,
                    favorite_mutation,
                    favorites_store,
                    || async move {
                        command
                            .execute_branch(
                                &path,
                                BranchCommand::Delete {
                                    name,
                                    allow_unmerged,
                                },
                                context,
                            )
                            .await
                    },
                )
                .await
                .map_err(|failure| match failure {
                    branches::BranchTaskFailure::Command(failure) => failure,
                    branches::BranchTaskFailure::StorageUnavailable => TaskFailure::command_failed(
                        "Branch favorite storage is unavailable.".into(),
                    ),
                })?;
                Ok(None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

/// Git removes the registration even when deleting the working directory fails.
/// Only recover that partial result, while the caller still holds directory access.
async fn finish_worktree_removal(
    command: &crate::git::command::GitCommandService,
    repository: &std::path::Path,
    directory: &std::path::Path,
    force: bool,
    result: Result<(), TaskFailure>,
) -> Result<(), TaskFailure> {
    let Err(failure) = result else {
        return Ok(());
    };
    if !force
        || !matches!(&failure, TaskFailure::Diagnosed { failure, .. }
            if failure.code == GitFailureCode::CommandFailed && failure.exit_code.is_some())
    {
        return Err(failure);
    }
    let entries = command.list_worktrees(repository).await?;
    for entry in entries {
        let candidate = crate::storage::repository_paths::canonicalize_prospective(
            std::path::Path::new(&entry.path),
        )
        .await
        .map_err(|_| {
            TaskFailure::diagnosed(
                GitFailureCode::PreconditionChanged,
                "Worktree folder identity could not be verified",
            )
        })?;
        if candidate == directory {
            return Err(failure);
        }
    }
    let identity = crate::storage::repository_paths::canonicalize_prospective(directory)
        .await
        .map_err(|_| {
            TaskFailure::diagnosed(
                GitFailureCode::PreconditionChanged,
                "Worktree folder identity could not be verified",
            )
        })?;
    if identity != directory {
        return Err(TaskFailure::diagnosed(
            GitFailureCode::PreconditionChanged,
            "Worktree folder identity changed. Refresh and retry.",
        ));
    }
    match tokio::fs::remove_dir_all(directory).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(TaskFailure::command_failed(format!(
            "Git removed the worktree registration, but its folder could not be deleted: {error}"
        ))),
    }
}

pub(super) async fn set_branch_favorite(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<BranchFavoriteRequest>, JsonRejection>,
) -> Result<Json<branches::BranchSnapshot>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A branch ref and favorite state are required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = branches::set_branch_favorite_with_git(
        branches::SetFavoriteCommand {
            repo_id,
            repository_path: target.repository_path,
            current_branch: metadata.branch,
            detached: metadata.detached,
            full_name: request.full_name,
            favorite: request.favorite,
        },
        state.branch_git.as_ref(),
        state.branch_favorites.clone(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    Ok(Json(snapshot))
}

pub(super) async fn create_repository_branch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<CreateBranchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A branch name is required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    branches::validate_branch_name_with_git(
        &target.repository_path,
        &request.name,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    branches::ensure_branch_creation_allowed_with_git(
        &target.repository_path,
        &request.name,
        metadata.head.is_some(),
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    if let Some(worktree_path) = request.worktree_path.as_deref() {
        validate_new_worktree_folder(worktree_path)?;
    }
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let branch_name = request.name;
    let checkout = request.checkout;
    let worktree_path = request.worktree_path;
    let start_point = match request.start_point.as_deref() {
        Some(start) => {
            if !(4..=64).contains(&start.len())
                || !start.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::RequestInvalid,
                    "The start point must be a commit ID.",
                ));
            }
            Some(
                crate::ports::git::GitReadPort::resolve_commit_target(
                    &state.git_commands,
                    &path,
                    start,
                )
                .await
                .map_err(|_| {
                    ApiError::new(
                        StatusCode::NOT_FOUND,
                        ApiErrorCode::HistoryCommitNotFound,
                        "That commit could not be found in this repository.",
                    )
                })?,
            )
        }
        None => None,
    };
    if !request.copy_files.is_empty() && worktree_path.is_none() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Local files can only be copied into a new worktree.",
        ));
    }
    validate_copy_files(&state, &path, &request.copy_files).await?;
    let copy_source = path.clone();
    let copy_list = request.copy_files;
    let repositories = state.repositories.clone();
    let directory_repo_id = repo_id.clone();
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            if worktree_path.is_some() {
                "worktreeCreate"
            } else {
                "branchCreate"
            },
            move |context| async move {
                let (worktree_path, _directory) = match worktree_path {
                    Some(folder) => {
                        let (resolved, permit) =
                            worktree_directory_permit(&context, &directory_repo_id, folder.into())
                                .await?;
                        let folder = resolved
                            .to_str()
                            .ok_or_else(|| {
                                TaskFailure::diagnosed(
                                    GitFailureCode::PreconditionChanged,
                                    "Worktree folder cannot be represented safely",
                                )
                            })?
                            .to_owned();
                        validate_new_worktree_folder(&folder).map_err(|error| {
                            TaskFailure::diagnosed(
                                GitFailureCode::PreconditionChanged,
                                error.message,
                            )
                        })?;
                        (Some(folder), permit)
                    }
                    None => (None, None),
                };
                let new_worktree_folder = worktree_path.clone();
                let task_context = context.clone();
                command
                    .execute_branch(
                        &path,
                        BranchCommand::Create {
                            name: branch_name,
                            checkout,
                            worktree_path,
                            start_point,
                        },
                        context,
                    )
                    .await?;
                if let Some(folder) = new_worktree_folder.clone() {
                    copy_into_worktree(
                        &task_context,
                        &command,
                        &_directory,
                        copy_source,
                        folder,
                        copy_list,
                    )
                    .await;
                }
                // Register the new worktree so the app can open it right away.
                Ok(match new_worktree_folder {
                    Some(folder) => repositories
                        .open_path(&folder)
                        .await
                        .ok()
                        .map(|repository| repository.repo_id),
                    None => None,
                })
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn branch_for_mutation(
    state: &AppState,
    repo_id: &str,
    name: &str,
) -> Result<(TaskTarget, Repository), ApiError> {
    let target = state
        .repository_targets
        .task_target(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    branches::require_local_branch_with_git(
        &target.repository_path,
        name,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    Ok((target, metadata))
}

pub(super) async fn rename_repository_branch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RenameBranchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Both branch names are required.",
        )
    })?;
    let (target, _) = branch_for_mutation(&state, &repo_id, &request.name).await?;
    branches::validate_branch_rename_with_git(
        &target.repository_path,
        &request.name,
        &request.new_name,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let favorites_store = state.branch_favorites.clone();
    let repo_for_favorite = repo_id.clone();
    let old_full_name = format!("refs/heads/{}", request.name);
    let new_full_name = format!("refs/heads/{}", request.new_name);
    let favorite_mutation = branches::BranchFavoriteMutation::Rename {
        old_full_name,
        new_full_name,
    };
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "branchRename",
            move |context| async move {
                branches::execute_branch_and_update_favorites(
                    repo_for_favorite,
                    favorite_mutation,
                    favorites_store,
                    || async move {
                        command
                            .execute_branch(
                                &path,
                                BranchCommand::Rename {
                                    old_name: request.name,
                                    new_name: request.new_name,
                                },
                                context,
                            )
                            .await
                    },
                )
                .await
                .map_err(|failure| match failure {
                    branches::BranchTaskFailure::Command(failure) => failure,
                    branches::BranchTaskFailure::StorageUnavailable => TaskFailure::command_failed(
                        "Branch favorite storage is unavailable.".into(),
                    ),
                })?;
                Ok(None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn preview_repository_branch_delete(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<BranchNameRequest>, JsonRejection>,
) -> Result<Json<BranchDeletePreview>, ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A branch name is required.",
        )
    })?;
    let (target, metadata) = branch_for_mutation(&state, &repo_id, &request.name).await?;
    let preview = branches::preview_branch_delete_with_git(
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        &request.name,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    Ok(Json(BranchDeletePreview {
        name: request.name,
        is_current: preview.is_current,
        unmerged_commit_count: preview.unmerged_commit_count,
        requires_confirmation: preview.requires_confirmation,
    }))
}

pub(super) async fn delete_repository_branch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<DeleteBranchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A branch name and confirmation choice are required.",
        )
    })?;
    let (target, metadata) = branch_for_mutation(&state, &repo_id, &request.name).await?;
    branches::validate_branch_delete_with_git(
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        &request.name,
        request.allow_unmerged,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let favorites_store = state.branch_favorites.clone();
    let repo_for_favorite = repo_id.clone();
    let full_name = format!("refs/heads/{}", request.name);
    let favorite_mutation = branches::BranchFavoriteMutation::Remove { full_name };
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "branchDelete",
            move |context| async move {
                branches::execute_branch_and_update_favorites(
                    repo_for_favorite,
                    favorite_mutation,
                    favorites_store,
                    || async move {
                        command
                            .execute_branch(
                                &path,
                                BranchCommand::Delete {
                                    name: request.name,
                                    allow_unmerged: request.allow_unmerged,
                                },
                                context,
                            )
                            .await
                    },
                )
                .await
                .map_err(|failure| match failure {
                    branches::BranchTaskFailure::Command(failure) => failure,
                    branches::BranchTaskFailure::StorageUnavailable => TaskFailure::command_failed(
                        "Branch favorite storage is unavailable.".into(),
                    ),
                })?;
                Ok(None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

/// How a switch to a remote-tracking branch such as `origin/feature` is carried out: through the
/// local branch that already tracks it, or through a new tracking branch named after it.
struct RemoteSwitchPlan {
    remote_name: String,
    remote_branch: String,
    /// `refs/remotes/<remote>/<branch>`.
    remote_ref: String,
    local_branch: String,
    creates_local_branch: bool,
}

async fn plan_remote_switch(
    state: &AppState,
    repository_path: &std::path::Path,
    name: &str,
    current: Option<&str>,
) -> Result<RemoteSwitchPlan, ApiError> {
    let Some((remote_name, remote_branch)) = name
        .split_once('/')
        .filter(|(remote, branch)| !remote.is_empty() && !branch.is_empty() && *branch != "HEAD")
    else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A remote branch looks like origin/feature.",
        ));
    };
    let references = state
        .branch_git
        .list_references(repository_path)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::RequestInvalid,
                "Could not read the branches of this repository.",
            )
        })?;
    let remote_ref = format!("refs/remotes/{name}");
    if !references
        .iter()
        .any(|reference| reference.full_name == remote_ref)
    {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::BranchNotFound,
            "That remote branch is not available. Fetch and try again.",
        ));
    }
    // Prefer the tracking branch named like the remote branch when several track it.
    let tracking = references
        .iter()
        .filter(|reference| {
            reference.full_name.starts_with("refs/heads/")
                && reference.upstream.as_deref() == Some(name)
        })
        .min_by_key(|reference| reference.name != remote_branch);
    let (local_branch, creates_local_branch) = match tracking {
        Some(local) => {
            if current == Some(local.name.as_str()) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    ApiErrorCode::BranchCurrent,
                    format!("The current branch already tracks {name}. Pull to update it."),
                ));
            }
            if local.worktree_path.is_some() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    ApiErrorCode::RequestInvalid,
                    format!(
                        "{} tracks {name} and is checked out in another worktree. Open that worktree instead.",
                        local.name
                    ),
                ));
            }
            (local.name.clone(), false)
        }
        None => {
            if references
                .iter()
                .any(|reference| reference.full_name == format!("refs/heads/{remote_branch}"))
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    ApiErrorCode::BranchAlreadyExists,
                    format!("A local branch named {remote_branch} already exists but does not track {name}. Switch to it from the local branches instead."),
                ));
            }
            branches::validate_branch_name_with_git(
                repository_path,
                remote_branch,
                state.branch_git.as_ref(),
            )
            .await
            .map_err(ApiError::from_branch_error)?;
            (remote_branch.to_owned(), true)
        }
    };
    Ok(RemoteSwitchPlan {
        remote_name: remote_name.to_owned(),
        remote_branch: remote_branch.to_owned(),
        remote_ref,
        local_branch,
        creates_local_branch,
    })
}

pub(super) async fn preflight_branch_switch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<BranchNameQuery>, QueryRejection>,
) -> Result<Json<BranchSwitchPreflight>, ApiError> {
    let Query(request) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A target branch name is required.",
        )
    })?;
    // A remote target is compared with its last fetched state; the switch fetches and checks again.
    let (target, metadata, compare_ref, local_branch, creates_local_branch) = if request.commit {
        let (target, metadata, oid) = commit_for_checkout(&state, &repo_id, &request.name).await?;
        (target, metadata, oid.clone(), oid, false)
    } else if request.remote {
        let target = state
            .repository_targets
            .task_target(&repo_id)
            .await
            .map_err(ApiError::from_repository_error)?;
        let metadata = state
            .repositories
            .refresh_metadata(&repo_id)
            .await
            .map_err(ApiError::from_repository_error)?;
        let plan = plan_remote_switch(
            &state,
            &target.repository_path,
            &request.name,
            metadata.branch.as_deref(),
        )
        .await?;
        (
            target,
            metadata,
            plan.remote_ref,
            plan.local_branch,
            plan.creates_local_branch,
        )
    } else {
        let (target, metadata) = branch_for_mutation(&state, &repo_id, &request.name).await?;
        (
            target,
            metadata,
            request.name.clone(),
            request.name.clone(),
            false,
        )
    };
    let snapshot = state
        .status
        .snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let dirty_files = snapshot
        .files
        .iter()
        .filter(|file| file.has_unignored_changes())
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let potentially_overwritten_paths = if request.commit {
        match metadata.head.as_deref() {
            Some(head) => {
                branches::overlapping_dirty_paths_between_oids_with_git(
                    &target.repository_path,
                    head,
                    &compare_ref,
                    &dirty_files,
                    state.branch_git.as_ref(),
                )
                .await
            }
            None => Ok(Vec::new()),
        }
    } else {
        branches::overlapping_dirty_paths_with_git(
            &target.repository_path,
            metadata.head.as_deref(),
            &compare_ref,
            &dirty_files,
            state.branch_git.as_ref(),
        )
        .await
    }
    .map_err(ApiError::from_branch_error)?;
    Ok(Json(BranchSwitchPreflight {
        repo_id,
        current: metadata.branch,
        target: request.name,
        local_branch,
        creates_local_branch,
        detached: request.commit,
        is_clean: dirty_files.is_empty(),
        dirty_files,
        potentially_overwritten_paths,
    }))
}

pub(super) async fn switch_repository_branch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<SwitchBranchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A target branch name is required.",
        )
    })?;
    if request.commit {
        return switch_to_commit(state, repo_id, request.name).await;
    }
    if request.remote {
        return switch_to_remote_branch(state, repo_id, request.name).await;
    }
    let (target, metadata) = branch_for_mutation(&state, &repo_id, &request.name).await?;
    branches::ensure_branch_not_current(metadata.branch.as_deref(), &request.name)
        .map_err(ApiError::from_branch_error)?;
    let status = state
        .status
        .snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let dirty_files = status
        .files
        .iter()
        .filter(|file| file.has_unignored_changes())
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let expected_head = metadata.head.clone();
    let expected_branch = metadata.branch.clone();
    branches::ensure_no_dirty_path_overlap_with_git(
        &target.repository_path,
        metadata.head.as_deref(),
        &request.name,
        &dirty_files,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    let path = target.repository_path;
    let target_name = request.name;
    let repo_for_check = repo_id.clone();
    let repositories = state.repositories.clone();
    let status_service = state.status.clone();
    let command = state.git_commands.clone();
    let branch_git = state.branch_git.clone();
    let task = state
        .tasks
        .submit(Some(repo_id), None, target.resource_key, "branchSwitch", move |context| async move {
            let fresh_repository = repositories
                .refresh_metadata(&repo_for_check)
                .await
                .map_err(|_| TaskFailure::command_failed("Could not verify the current branch before switching.".into()))?;
            if fresh_repository.head != expected_head || fresh_repository.branch != expected_branch {
                return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "The current branch changed. Review branch state and retry the switch."));
            }
            let fresh_status = status_service.snapshot(&repo_for_check).await
                .map_err(|_| TaskFailure::command_failed("Could not verify the working tree before switching.".into()))?;
            let fresh_dirty_paths = fresh_status.files.iter()
                .filter(|file| file.has_unignored_changes())
                .map(|file| file.path.clone())
                .collect::<Vec<_>>();
            match branches::ensure_no_dirty_path_overlap_with_git(&path, fresh_repository.head.as_deref(), &target_name, &fresh_dirty_paths, branch_git.as_ref()).await {
                Ok(()) => {}
                Err(branches::BranchError::WorktreeDirty) => return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "The working tree changed and now overlaps the target branch. Commit or shelve the listed changes before retrying.")),
                Err(_) => return Err(TaskFailure::command_failed("Could not verify whether local edits overlap the target branch.".into())),
            }
            command.execute_branch(&path, BranchCommand::Switch { name: target_name }, context).await?;
            repositories
                .refresh_metadata(&repo_for_check)
                .await
                .map_err(|_| TaskFailure::command_failed("Branch switched but repository metadata could not be refreshed.".into()))?;
            Ok(None)
        }).await.map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

/// Resolves a commit id typed by the client to a full object id that names a commit.
async fn commit_for_checkout(
    state: &AppState,
    repo_id: &str,
    name: &str,
) -> Result<(TaskTarget, Repository, String), ApiError> {
    if !(4..=64).contains(&name.len()) || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A commit id is required.",
        ));
    }
    let target = state
        .repository_targets
        .task_target(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let oid = state
        .git_commands
        .resolve_commit_target(&target.repository_path, name)
        .await
        // The id is well-formed hex, so a failed lookup means no such commit.
        .map_err(|error| match error {
            WorkflowError::GitFailed => {
                ApiError::from_workflow_error(WorkflowError::CommitNotFound)
            }
            other => ApiError::from_workflow_error(other),
        })?;
    let metadata = state
        .repositories
        .refresh_metadata(repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    Ok((target, metadata, oid))
}

/// Checks out a commit with a detached HEAD, under the same overlap rules as a branch switch.
async fn switch_to_commit(
    state: AppState,
    repo_id: String,
    name: String,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let (target, metadata, oid) = commit_for_checkout(&state, &repo_id, &name).await?;
    branches::ensure_branch_not_current(metadata.head.as_deref(), &oid)
        .map_err(ApiError::from_branch_error)?;
    let status = state
        .status
        .snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let dirty_files = status
        .files
        .iter()
        .filter(|file| file.has_unignored_changes())
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    branches::ensure_no_dirty_path_overlap_between_oids_with_git(
        &target.repository_path,
        metadata.head.as_deref(),
        &oid,
        &dirty_files,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    let expected_head = metadata.head.clone();
    let expected_branch = metadata.branch.clone();
    let path = target.repository_path;
    let repo_for_check = repo_id.clone();
    let repositories = state.repositories.clone();
    let status_service = state.status.clone();
    let command = state.git_commands.clone();
    let branch_git = state.branch_git.clone();
    let task = state
        .tasks
        .submit(Some(repo_id), None, target.resource_key, "branchSwitchCommit", move |context| async move {
            let fresh_repository = repositories
                .refresh_metadata(&repo_for_check)
                .await
                .map_err(|_| TaskFailure::command_failed("Could not verify the current branch before checking out.".into()))?;
            if fresh_repository.head != expected_head || fresh_repository.branch != expected_branch {
                return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "The current branch changed. Review branch state and retry the checkout."));
            }
            let fresh_status = status_service.snapshot(&repo_for_check).await
                .map_err(|_| TaskFailure::command_failed("Could not verify the working tree before checking out.".into()))?;
            let fresh_dirty_paths = fresh_status.files.iter()
                .filter(|file| file.has_unignored_changes())
                .map(|file| file.path.clone())
                .collect::<Vec<_>>();
            match branches::ensure_no_dirty_path_overlap_between_oids_with_git(&path, fresh_repository.head.as_deref(), &oid, &fresh_dirty_paths, branch_git.as_ref()).await {
                Ok(()) => {}
                Err(branches::BranchError::WorktreeDirty) => return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "The working tree changed and now overlaps the target commit. Commit or shelve the listed changes before retrying.")),
                Err(_) => return Err(TaskFailure::command_failed("Could not verify whether local edits overlap the target commit.".into())),
            }
            command.execute_branch(&path, BranchCommand::SwitchDetached { oid }, context).await?;
            repositories
                .refresh_metadata(&repo_for_check)
                .await
                .map_err(|_| TaskFailure::command_failed("Commit checked out but repository metadata could not be refreshed.".into()))?;
            Ok(None)
        }).await.map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

/// Fetches the remote branch, then checks it out through a local tracking branch: a new one is
/// created at the fetched commit, or the existing one is fast-forwarded to it when it has no
/// commits of its own. A tracking branch that has diverged is checked out as it is.
async fn switch_to_remote_branch(
    state: AppState,
    repo_id: String,
    name: String,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    plan_remote_switch(
        &state,
        &target.repository_path,
        &name,
        metadata.branch.as_deref(),
    )
    .await?;
    let expected_head = metadata.head.clone();
    let expected_branch = metadata.branch.clone();
    let path = target.repository_path;
    let repo_for_check = repo_id.clone();
    let task_state = state.clone();
    let task = state
        .tasks
        .submit(Some(repo_id), None, target.resource_key, "branchSwitchRemote", move |context| async move {
            let state = task_state;
            // Plan again now that the task holds the repository: branches may have changed since the request.
            let plan = plan_remote_switch(&state, &path, &name, expected_branch.as_deref()).await
                .map_err(|error| TaskFailure::command_failed(error.message))?;
            state.git_commands
                .fetch_remote_branch(&path, &plan.remote_name, &plan.remote_branch, context.clone())
                .await?;
            let fresh_repository = state.repositories
                .refresh_metadata(&repo_for_check)
                .await
                .map_err(|_| TaskFailure::command_failed("Could not verify the current branch before switching.".into()))?;
            if fresh_repository.head != expected_head || fresh_repository.branch != expected_branch {
                return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "The current branch changed. Review branch state and retry the switch."));
            }
            let references = state.branch_git.list_references(&path).await
                .map_err(|_| TaskFailure::command_failed("Could not read the fetched remote branch.".into()))?;
            let Some(remote_oid) = references.iter()
                .find(|reference| reference.full_name == plan.remote_ref)
                .map(|reference| reference.oid.clone())
            else {
                return Err(TaskFailure::command_failed(format!("{name} no longer exists on the remote.")));
            };
            // Where the working tree will end up, and the fast-forward that moves the local branch there.
            let (checkout_ref, fast_forward) = if plan.creates_local_branch {
                (plan.remote_ref.clone(), None)
            } else {
                let local_oid = references.iter()
                    .find(|reference| reference.full_name == format!("refs/heads/{}", plan.local_branch))
                    .map(|reference| reference.oid.clone())
                    .ok_or_else(|| TaskFailure::command_failed(format!("{} no longer exists.", plan.local_branch)))?;
                let local_only_commits = state.branch_git
                    .unmerged_commit_count(&path, &plan.remote_ref, &plan.local_branch)
                    .await
                    .map_err(|_| TaskFailure::command_failed("Could not compare the local branch with the remote branch.".into()))?;
                if local_oid == remote_oid {
                    (plan.remote_ref.clone(), None)
                } else if local_only_commits == 0 {
                    (plan.remote_ref.clone(), Some((local_oid, remote_oid)))
                } else {
                    context.log(format!(
                        "{} has {local_only_commits} commit(s) that are not on {name}, so it was not fast-forwarded. Pull to combine them.",
                        plan.local_branch
                    )).await;
                    (format!("refs/heads/{}", plan.local_branch), None)
                }
            };
            let fresh_status = state.status.snapshot(&repo_for_check).await
                .map_err(|_| TaskFailure::command_failed("Could not verify the working tree before switching.".into()))?;
            let fresh_dirty_paths = fresh_status.files.iter()
                .filter(|file| file.has_unignored_changes())
                .map(|file| file.path.clone())
                .collect::<Vec<_>>();
            match branches::ensure_no_dirty_path_overlap_with_git(&path, fresh_repository.head.as_deref(), &checkout_ref, &fresh_dirty_paths, state.branch_git.as_ref()).await {
                Ok(()) => {}
                Err(branches::BranchError::WorktreeDirty) => return Err(TaskFailure::diagnosed(GitFailureCode::PreconditionChanged, "Local edits overlap files that differ on the remote branch. Commit or shelve the listed changes before retrying.")),
                Err(_) => return Err(TaskFailure::command_failed("Could not verify whether local edits overlap the remote branch.".into())),
            }
            if plan.creates_local_branch {
                state.git_commands.execute_branch(&path, BranchCommand::SwitchTracking {
                    local_branch: plan.local_branch.clone(),
                    remote_ref: name.clone(),
                }, context).await?;
            } else {
                if let Some((expected_oid, new_oid)) = fast_forward {
                    state.git_commands.execute_branch(&path, BranchCommand::FastForward {
                        name: plan.local_branch.clone(),
                        new_oid,
                        expected_oid,
                    }, context.clone()).await?;
                }
                state.git_commands.execute_branch(&path, BranchCommand::Switch { name: plan.local_branch.clone() }, context).await?;
            }
            state.repositories
                .refresh_metadata(&repo_for_check)
                .await
                .map_err(|_| TaskFailure::command_failed("Branch switched but repository metadata could not be refreshed.".into()))?;
            Ok(None)
        }).await.map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

#[cfg(test)]
mod worktree_removal_tests {
    use super::*;
    use crate::{domain::git_result::GitCommandFailure, git::command::GitCommandService};

    fn git(path: &std::path::Path, arguments: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn partial_failure() -> Result<(), TaskFailure> {
        Err(TaskFailure::Diagnosed {
            failure: GitCommandFailure {
                code: GitFailureCode::CommandFailed,
                exit_code: Some(255),
                diagnostics_truncated: false,
            },
            message: "Git command failed with exit code 255".into(),
        })
    }

    #[tokio::test]
    async fn force_removal_cleans_residue_only_after_git_unregisters_the_worktree() {
        let root = tempfile::tempdir().unwrap();
        let repository = root.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "--quiet"]);
        git(
            &repository,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "--allow-empty",
                "-m",
                "seed",
            ],
        );
        let linked = root.path().join("linked");
        git(
            &repository,
            &["worktree", "add", "--detach", linked.to_str().unwrap()],
        );
        let linked = crate::storage::repository_paths::canonicalize_prospective(&linked)
            .await
            .unwrap();
        let command = GitCommandService::default();
        // A Git refusal (for example a lock) must not trigger recursive deletion.
        assert!(
            finish_worktree_removal(&command, &repository, &linked, true, partial_failure())
                .await
                .is_err()
        );
        assert!(linked.join(".git").exists());
        git(
            &repository,
            &["worktree", "remove", linked.to_str().unwrap()],
        );
        // Model the partial result: Git registration is gone but files remain.
        std::fs::create_dir(&linked).unwrap();
        std::fs::write(linked.join("remaining.txt"), "residue").unwrap();
        assert!(
            finish_worktree_removal(&command, &repository, &linked, false, partial_failure())
                .await
                .is_err()
        );
        assert!(linked.join("remaining.txt").exists());
        assert!(finish_worktree_removal(
            &command,
            &repository,
            &linked,
            true,
            Err(TaskFailure::Cancelled)
        )
        .await
        .is_err());
        assert!(linked.join("remaining.txt").exists());
        finish_worktree_removal(&command, &repository, &linked, true, partial_failure())
            .await
            .unwrap();
        assert!(!linked.exists());
        assert!(repository.join(".git").exists());
    }
}
