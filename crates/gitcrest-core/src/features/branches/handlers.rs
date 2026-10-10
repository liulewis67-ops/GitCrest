use axum::{
    extract::{rejection::JsonRejection, rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::branch::BranchCommand,
    domain::status::ChangeCategory,
    features::branches,
    features::repositories::{Repository, TaskTarget},
    AppState, TaskFailure, TaskSnapshot,
};

use super::dto::{
    BranchDeletePreview, BranchFavoriteRequest, BranchNameQuery, BranchNameRequest,
    BranchSwitchPreflight, CreateBranchRequest, DeleteBranchRequest, RenameBranchRequest,
    SwitchBranchRequest,
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
        repo_id,
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        &request.full_name,
        request.favorite,
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
    if metadata.head.is_none() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchRequiresCommit,
            "Create an initial commit before creating a branch.",
        ));
    }
    let existing = branches::read_branches_with_git(
        repo_id.clone(),
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    if existing.branches.iter().any(|branch| {
        matches!(branch.kind, branches::BranchKind::Local) && branch.name == request.name
    }) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchAlreadyExists,
            "A local branch with this name already exists.",
        ));
    }
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let branch_name = request.name;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "branchCreate",
            move |context| async move {
                command
                    .execute_branch(&path, BranchCommand::Create { name: branch_name }, context)
                    .await
                    .map(|()| None)
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
    branches::validate_branch_name_with_git(
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
    if !branches::read_branches_with_git(
        repo_id.to_owned(),
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?
    .branches
    .iter()
    .any(|branch| matches!(branch.kind, branches::BranchKind::Local) && branch.name == name)
    {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::BranchNotFound,
            "The local branch does not exist.",
        ));
    }
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
    branches::validate_branch_name_with_git(
        &target.repository_path,
        &request.new_name,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    if request.name == request.new_name {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::BranchNameInvalid,
            "Choose a different branch name.",
        ));
    }
    let snapshot = branches::read_branches_with_git(
        repo_id.clone(),
        &target.repository_path,
        None,
        false,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    if snapshot.branches.iter().any(|branch| {
        matches!(branch.kind, branches::BranchKind::Local) && branch.name == request.new_name
    }) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchAlreadyExists,
            "A local branch with this name already exists.",
        ));
    }
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let favorites_store = state.branch_favorites.clone();
    let repo_for_favorite = repo_id.clone();
    let old_full_name = format!("refs/heads/{}", request.name);
    let new_full_name = format!("refs/heads/{}", request.new_name);
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "branchRename",
            move |context| async move {
                command
                    .execute_branch(
                        &path,
                        BranchCommand::Rename {
                            old_name: request.name,
                            new_name: request.new_name,
                        },
                        context,
                    )
                    .await?;
                tokio::task::spawn_blocking(move || {
                    favorites_store.rename_branch_favorite(
                        &repo_for_favorite,
                        &old_full_name,
                        &new_full_name,
                    )
                })
                .await
                .map_err(|_| TaskFailure::Failed("Branch favorite storage is unavailable.".into()))?
                .map_err(|_| {
                    TaskFailure::Failed("Branch favorite storage is unavailable.".into())
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
    let is_current = metadata.branch.as_deref() == Some(request.name.as_str());
    let unmerged_commit_count = match metadata.branch.as_deref() {
        Some(current) if !metadata.detached => branches::unmerged_commit_count_with_git(
            &target.repository_path,
            current,
            &request.name,
            state.branch_git.as_ref(),
        )
        .await
        .map_err(ApiError::from_branch_error)?,
        _ => 0,
    };
    Ok(Json(BranchDeletePreview {
        name: request.name,
        is_current,
        unmerged_commit_count,
        requires_confirmation: unmerged_commit_count > 0,
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
    if metadata.branch.as_deref() == Some(request.name.as_str()) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchCurrent,
            "Switch to another branch before deleting the current branch.",
        ));
    }
    let unmerged = match metadata.branch.as_deref() {
        Some(current) if !metadata.detached => branches::unmerged_commit_count_with_git(
            &target.repository_path,
            current,
            &request.name,
            state.branch_git.as_ref(),
        )
        .await
        .map_err(ApiError::from_branch_error)?,
        _ => 0,
    };
    if unmerged > 0 && !request.allow_unmerged {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchUnmerged,
            format!("The branch has {unmerged} commit(s) not reachable from the current branch; confirm deletion to continue."),
        ));
    }
    let path = target.repository_path;
    let command = state.git_commands.clone();
    let favorites_store = state.branch_favorites.clone();
    let repo_for_favorite = repo_id.clone();
    let full_name = format!("refs/heads/{}", request.name);
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "branchDelete",
            move |context| async move {
                command
                    .execute_branch(
                        &path,
                        BranchCommand::Delete {
                            name: request.name,
                            allow_unmerged: request.allow_unmerged,
                        },
                        context,
                    )
                    .await?;
                tokio::task::spawn_blocking(move || {
                    favorites_store.remove_branch_favorite(&repo_for_favorite, &full_name)
                })
                .await
                .map_err(|_| TaskFailure::Failed("Branch favorite storage is unavailable.".into()))?
                .map_err(|_| {
                    TaskFailure::Failed("Branch favorite storage is unavailable.".into())
                })?;
                Ok(None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
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
    let (target, metadata) = branch_for_mutation(&state, &repo_id, &request.name).await?;
    let snapshot = state
        .status
        .snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let dirty_files = snapshot
        .files
        .iter()
        .filter(|file| {
            !file
                .categories
                .iter()
                .all(|category| matches!(category, ChangeCategory::Ignored))
        })
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let changed_in_target = match metadata.head.as_deref() {
        Some(head) => branches::paths_changed_between_with_git(
            &target.repository_path,
            head,
            &request.name,
            state.branch_git.as_ref(),
        )
        .await
        .map_err(ApiError::from_branch_error)?,
        None => Vec::new(),
    };
    let potentially_overwritten_paths = dirty_files
        .iter()
        .filter(|path| changed_in_target.contains(path))
        .cloned()
        .collect();
    Ok(Json(BranchSwitchPreflight {
        repo_id,
        current: metadata.branch,
        target: request.name,
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
    let (target, metadata) = branch_for_mutation(&state, &repo_id, &request.name).await?;
    if metadata.branch.as_deref() == Some(request.name.as_str()) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchCurrent,
            "This branch is already checked out.",
        ));
    }
    let status = state
        .status
        .snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let dirty_files = status
        .files
        .iter()
        .filter(|file| {
            !file
                .categories
                .iter()
                .all(|category| matches!(category, ChangeCategory::Ignored))
        })
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let expected_head = metadata.head.clone();
    let expected_branch = metadata.branch.clone();
    if dirty_paths_overlap_branch_target(
        &target.repository_path,
        metadata.head.as_deref(),
        &request.name,
        &dirty_files,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::BranchWorktreeDirty,
            "The target branch changes paths with local edits. Commit or shelve those changes before switching.",
        ));
    }
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
                .map_err(|_| TaskFailure::Failed("Could not verify the current branch before switching.".into()))?;
            if fresh_repository.head != expected_head || fresh_repository.branch != expected_branch {
                return Err(TaskFailure::Failed("The current branch changed. Review branch state and retry the switch.".into()));
            }
            let fresh_status = status_service.snapshot(&repo_for_check).await
                .map_err(|_| TaskFailure::Failed("Could not verify the working tree before switching.".into()))?;
            let fresh_dirty_paths = fresh_status.files.iter()
                .filter(|file| !file.categories.iter().all(|category| matches!(category, ChangeCategory::Ignored)))
                .map(|file| file.path.clone())
                .collect::<Vec<_>>();
            if dirty_paths_overlap_branch_target(&path, fresh_repository.head.as_deref(), &target_name, &fresh_dirty_paths, branch_git.as_ref())
                .await
                .map_err(|_| TaskFailure::Failed("Could not verify whether local edits overlap the target branch.".into()))?
            {
                return Err(TaskFailure::Failed("The working tree changed and now overlaps the target branch. Commit or shelve the listed changes before retrying.".into()));
            }
            command.execute_branch(&path, BranchCommand::Switch { name: target_name }, context).await?;
            repositories
                .refresh_metadata(&repo_for_check)
                .await
                .map_err(|_| TaskFailure::Failed("Branch switched but repository metadata could not be refreshed.".into()))?;
            Ok(None)
        }).await.map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn dirty_paths_overlap_branch_target(
    repository_path: &std::path::Path,
    current_head: Option<&str>,
    target: &str,
    dirty_paths: &[String],
    git: &dyn crate::ports::branches::BranchGitPort,
) -> Result<bool, branches::BranchError> {
    if dirty_paths.is_empty() {
        return Ok(false);
    }
    let Some(current_head) = current_head else {
        return Ok(false);
    };
    let changed_paths =
        branches::paths_changed_between_with_git(repository_path, current_head, target, git)
            .await?;
    Ok(dirty_paths.iter().any(|path| changed_paths.contains(path)))
}
