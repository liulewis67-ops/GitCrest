use axum::{
    extract::{rejection::JsonRejection, rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::remote::{
        RemoteBranchDeleteCommand, RemoteCommand, RemotePullCommand, RemotePullStrategy,
        RemotePushCommand,
    },
    features::{branches, remotes as remote_service, repositories::TaskTarget},
    AppState, TaskFailure, TaskSnapshot,
};

use super::dto::{
    BranchUpstreamRequest, DefaultRemoteRequest, FetchRequest, PullRequest, PushRequest,
    PushTargetQuery, RemoteBranchDeletePreviewDto, RemoteBranchDeleteQuery,
    RemoteBranchDeleteRequest, RemoteNameRequest, RemoteRequest, RequiredNullableRemoteName,
};
use super::{pull, push};

pub(super) async fn fetch_repository(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<FetchRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A fetch options object is required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    if request.background
        && state.tasks.list().await.iter().any(|task| {
            task.repo_id.as_deref() == Some(repo_id.as_str()) && !task.status.is_terminal()
        })
    {
        return Err(ApiError::state_conflict(
            "Another Git task is running in this repository, so the background fetch was skipped.",
        ));
    }
    let command = state.remote_commands.clone();
    let path = target.repository_path;
    let operation = match (request.background, request.prune) {
        (true, _) => "fetchBackground",
        (false, true) => "fetchPrune",
        (false, false) => "fetch",
    };
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            operation,
            move |context| async move {
                command
                    .execute_fetch(&path, request.prune, request.all, context)
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn preflight_repository_pull(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<pull::PullPreflight>, ApiError> {
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
    pull::read_pull_preflight(
        repo_id,
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        state.branch_git.as_ref(),
        state.remote_preflight_read.as_ref(),
        state.remote_git.as_ref(),
    )
    .await
    .map(Json)
    .map_err(ApiError::from_pull_error)
}

pub(super) async fn pull_repository(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<PullRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Pull requires reviewed local and tracking OIDs and an explicit merge or rebase strategy.",
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
    let preflight = pull::read_pull_preflight(
        repo_id.clone(),
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        state.branch_git.as_ref(),
        state.remote_preflight_read.as_ref(),
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_pull_error)?;
    if preflight.local_oid != request.expected_local_oid
        || preflight.tracking_oid != request.expected_tracking_oid
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::PullPreflightStale,
            "The local branch or tracked upstream changed after preflight. Refresh the preview before pulling.",
        ));
    }
    if !preflight.is_clean {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::PullRequiresClean,
            "Pull requires a clean worktree with no unresolved conflicts or Git operation in progress. Review the preflight paths first.",
        ));
    }
    let command = state.remote_commands.clone();
    let path = target.repository_path;
    let operation_command = RemotePullCommand::from(&preflight);
    let git_reader = state.remote_preflight_read.clone();
    let recovery = state.remote_pull_recovery.clone();
    let branch_git = state.branch_git.clone();
    let remote_git = state.remote_git.clone();
    let task_repo_id = repo_id.clone();
    let strategy = RemotePullStrategy::from(request.strategy);
    let operation = match strategy {
        RemotePullStrategy::Merge => "pullMerge",
        RemotePullStrategy::Rebase => "pullRebase",
    };
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            operation,
            move |context| async move {
                let current = pull::read_pull_preflight(
                    task_repo_id,
                    &path,
                    Some(&operation_command.local_branch),
                    false,
                    branch_git.as_ref(),
                    git_reader.as_ref(),
                    remote_git.as_ref(),
                )
                .await
                .map_err(|_| {
                    TaskFailure::Failed(
                        "Pull preflight could not be revalidated. Refresh and review the repository state."
                            .into(),
                    )
                })?;
                if current.local_oid != operation_command.local_oid
                    || current.tracking_oid != operation_command.tracking_oid
                    || current.remote_name != operation_command.remote_name
                    || current.remote_branch != operation_command.remote_branch
                    || !current.is_clean
                {
                    return Err(TaskFailure::Failed(
                        "Pull preflight became stale or the worktree is no longer clean. Review repository state before pulling."
                            .into(),
                    ));
                }
                match command
                    .pull(&path, operation_command.clone(), strategy, context)
                    .await
                {
                    Err(TaskFailure::Cancelled) => {
                        super::recovery::reconcile_cancelled_pull(
                            &path,
                            &operation_command,
                            strategy,
                            git_reader.as_ref(),
                            recovery.as_ref(),
                        )
                        .await
                    }
                    result => result,
                }
                .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn preflight_repository_push(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<PushTargetQuery>, QueryRejection>,
) -> Result<Json<push::PushPreflight>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A push target must include both remoteName and remoteBranch.",
        )
    })?;
    let target_ref = match (query.remote_name.as_deref(), query.remote_branch.as_deref()) {
        (None, None) => None,
        (Some(remote_name), Some(remote_branch)) => Some((remote_name, remote_branch)),
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "A push target must include both remoteName and remoteBranch.",
            ));
        }
    };
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
    push::read_push_preflight_for_target(
        repo_id,
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        target_ref,
        state.branch_git.as_ref(),
        state.remote_git.as_ref(),
    )
    .await
    .map(Json)
    .map_err(ApiError::from_push_error)
}

pub(super) async fn push_repository(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<PushRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Push preflight OIDs and force-with-lease choice are required.",
        )
    })?;
    let target_ref = Some((request.remote_name.as_str(), request.remote_branch.as_str()));
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
    let preflight = push::read_push_preflight_for_target(
        repo_id.clone(),
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        target_ref,
        state.branch_git.as_ref(),
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_push_error)?;
    if preflight.local_oid != request.expected_local_oid
        || preflight.expected_remote_oid != request.expected_remote_oid
        || preflight.remote_name != request.remote_name
        || preflight.remote_branch != request.remote_branch
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::PushPreflightStale,
            "The local branch or tracked remote changed after preflight. Refresh the preview before pushing.",
        ));
    }
    if preflight.ahead == 0 {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::NothingToPush,
            "The current branch has no commits to push.",
        ));
    }
    if preflight.behind > 0 && !request.force_with_lease {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::PushRequiresFetch,
            "The remote contains commits missing locally. Fetch and review before a normal push.",
        ));
    }
    let command = state.remote_commands.clone();
    let path = target.repository_path;
    let mut operation_command = RemotePushCommand::from(&preflight);
    operation_command.tags = request.tags;
    let branch_git = state.branch_git.clone();
    let remote_git = state.remote_git.clone();
    let task_repo_id = repo_id.clone();
    let pipelines = state.pipelines.clone();
    let pushed = crate::features::pipelines::service::PushedBranch {
        repo_id: repo_id.clone(),
        branch: operation_command.local_branch.clone(),
        oid: operation_command.local_oid.clone(),
    };
    let force_with_lease = request.force_with_lease;
    let operation = if force_with_lease {
        "pushForceWithLease"
    } else {
        "push"
    };
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            operation,
            move |context| async move {
                let current = push::read_push_preflight_for_target(
                    task_repo_id,
                    &path,
                    Some(&operation_command.local_branch),
                    false,
                    Some((&operation_command.remote_name, &operation_command.remote_branch)),
                    branch_git.as_ref(),
                    remote_git.as_ref(),
                )
                .await
                .map_err(|_| {
                    TaskFailure::Failed(
                        "Push preflight could not be revalidated. Refresh and retry.".into(),
                    )
                })?;
                if current.local_oid != operation_command.local_oid
                    || current.expected_remote_oid != operation_command.expected_remote_oid
                    || current.remote_name != operation_command.remote_name
                    || current.remote_branch != operation_command.remote_branch
                {
                    return Err(TaskFailure::Failed(
                        "Push preflight became stale before execution. Refresh and review the target again.".into(),
                    ));
                }
                if current.ahead == 0 {
                    return Err(TaskFailure::Failed(
                        "There are no local commits to push.".into(),
                    ));
                }
                if current.behind > 0 && !force_with_lease {
                    return Err(TaskFailure::Failed(
                        "The remote has commits missing locally. Fetch and review before pushing."
                            .into(),
                    ));
                }
                command
                    .push(&path, operation_command, force_with_lease, context)
                    .await?;
                pipelines
                    .on_push_succeeded(pushed, crate::features::pipelines::engine::PushOrigin::User)
                    .await;
                Ok(None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn repository_remotes(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<remote_service::RemoteSnapshot>, ApiError> {
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    remote_service::read_remotes_with_git(
        repo_id,
        &target.repository_path,
        state.remote_git.as_ref(),
    )
    .await
    .map(Json)
    .map_err(ApiError::from_remote_error)
}

async fn submit_remote_command(
    state: &AppState,
    repo_id: String,
    target: TaskTarget,
    operation_name: &'static str,
    operation: RemoteCommand,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let path = target.repository_path;
    let command = state.remote_commands.clone();
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            operation_name,
            move |context| async move {
                command
                    .execute_remote(&path, operation, context)
                    .await
                    .map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}

pub(super) async fn add_repository_remote(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RemoteRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A remote name and URL are required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    remote_service::validate_remote_name_with_git(
        &target.repository_path,
        &request.name,
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    let url = request.url.ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A remote URL is required.",
        )
    })?;
    remote_service::validate_remote_url(&url).map_err(ApiError::from_remote_error)?;
    let snapshot = remote_service::read_remotes_with_git(
        repo_id.clone(),
        &target.repository_path,
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    if snapshot
        .remotes
        .iter()
        .any(|remote| remote.name == request.name)
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::RemoteAlreadyExists,
            "A remote with this name already exists.",
        ));
    }
    submit_remote_command(
        &state,
        repo_id,
        target,
        "remoteAdd",
        RemoteCommand::Add {
            name: request.name,
            url,
        },
    )
    .await
}

pub(super) async fn set_repository_remote_url(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RemoteRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A remote name and URL are required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    remote_service::validate_remote_name_with_git(
        &target.repository_path,
        &request.name,
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    let url = request.url.ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A remote URL is required.",
        )
    })?;
    remote_service::validate_remote_url(&url).map_err(ApiError::from_remote_error)?;
    let snapshot = remote_service::read_remotes_with_git(
        repo_id.clone(),
        &target.repository_path,
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    if !snapshot
        .remotes
        .iter()
        .any(|remote| remote.name == request.name)
    {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::RemoteNotFound,
            "The remote does not exist.",
        ));
    }
    submit_remote_command(
        &state,
        repo_id,
        target,
        "remoteSetUrl",
        RemoteCommand::SetUrl {
            name: request.name,
            url,
        },
    )
    .await
}

pub(super) async fn delete_repository_remote(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RemoteNameRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A remote name is required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    remote_service::validate_remote_name_with_git(
        &target.repository_path,
        &request.name,
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    let snapshot = remote_service::read_remotes_with_git(
        repo_id.clone(),
        &target.repository_path,
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    if !snapshot
        .remotes
        .iter()
        .any(|remote| remote.name == request.name)
    {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::RemoteNotFound,
            "The remote does not exist.",
        ));
    }
    let next_default = if snapshot.default_remote.as_deref() == Some(request.name.as_str()) {
        Some(
            snapshot
                .remotes
                .iter()
                .filter(|remote| remote.name != request.name)
                .map(|remote| remote.name.as_str())
                .find(|name| *name == "origin")
                .or_else(|| {
                    snapshot
                        .remotes
                        .iter()
                        .find(|remote| remote.name != request.name)
                        .map(|remote| remote.name.as_str())
                })
                .unwrap_or_default()
                .to_owned(),
        )
    } else {
        None
    };
    submit_remote_command(
        &state,
        repo_id,
        target,
        "remoteDelete",
        RemoteCommand::Remove {
            name: request.name,
            next_default,
        },
    )
    .await
}

pub(super) async fn set_default_remote(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<DefaultRemoteRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A remote name or null is required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = remote_service::read_remotes_with_git(
        repo_id.clone(),
        &target.repository_path,
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    let name = match request.name {
        RequiredNullableRemoteName::Value(name) => Some(name),
        RequiredNullableRemoteName::Null(()) => None,
    };
    if let Some(name) = name.as_deref() {
        remote_service::validate_remote_name_with_git(
            &target.repository_path,
            name,
            state.remote_git.as_ref(),
        )
        .await
        .map_err(ApiError::from_remote_error)?;
        if !snapshot.remotes.iter().any(|remote| remote.name == name) {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RemoteNotFound,
                "The remote does not exist.",
            ));
        }
    }
    submit_remote_command(
        &state,
        repo_id,
        target,
        "remoteSetDefault",
        RemoteCommand::SetDefault {
            name: name.unwrap_or_default(),
        },
    )
    .await
}

pub(super) async fn set_branch_upstream(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<BranchUpstreamRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A local branch and remote tracking branch are required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    branches::validate_branch_name_with_git(
        &target.repository_path,
        &request.local_branch,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    remote_service::validate_remote_name_with_git(
        &target.repository_path,
        &request.remote_name,
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    branches::validate_branch_name_with_git(
        &target.repository_path,
        &request.remote_branch,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    let remotes_snapshot = remote_service::read_remotes_with_git(
        repo_id.clone(),
        &target.repository_path,
        state.remote_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    if !remotes_snapshot
        .remotes
        .iter()
        .any(|remote| remote.name == request.remote_name)
    {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::RemoteNotFound,
            "The remote does not exist.",
        ));
    }
    let metadata = state
        .repositories
        .refresh_metadata(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let branches_snapshot = branches::read_branches_with_git(
        repo_id.clone(),
        &target.repository_path,
        metadata.branch.as_deref(),
        metadata.detached,
        state.branch_git.as_ref(),
    )
    .await
    .map_err(ApiError::from_branch_error)?;
    let local_exists = branches_snapshot.branches.iter().any(|branch| {
        matches!(branch.kind, branches::BranchKind::Local) && branch.name == request.local_branch
    });
    let remote_full_name = format!(
        "refs/remotes/{}/{}",
        request.remote_name, request.remote_branch
    );
    let upstream_exists = branches_snapshot.branches.iter().any(|branch| {
        matches!(branch.kind, branches::BranchKind::Remote) && branch.full_name == remote_full_name
    });
    if !local_exists || !upstream_exists {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::BranchNotFound,
            "The local branch or remote tracking branch does not exist.",
        ));
    }
    submit_remote_command(
        &state,
        repo_id,
        target,
        "remoteSetUpstream",
        RemoteCommand::SetUpstream {
            local_branch: request.local_branch,
            remote_name: request.remote_name,
            remote_branch: request.remote_branch,
        },
    )
    .await
}

pub(super) async fn preview_repository_remote_branch_delete(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<RemoteBranchDeleteQuery>, QueryRejection>,
) -> Result<Json<RemoteBranchDeletePreviewDto>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A configured remote and remote branch are required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    remote_service::read_remote_branch_delete_preview(
        state.remote_preflight_read.as_ref(),
        state.branch_git.as_ref(),
        state.remote_git.as_ref(),
        repo_id,
        &target.repository_path,
        &query.remote_name,
        &query.remote_branch,
    )
    .await
    .map(RemoteBranchDeletePreviewDto::from)
    .map(Json)
    .map_err(ApiError::from_remote_error)
}

pub(super) async fn delete_repository_remote_branch(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<RemoteBranchDeleteRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Remote branch deletion requires the reviewed branch, target OID, and preview revision.",
        )
    })?;
    if !request.confirm_delete {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "Deleting a remote branch requires explicit confirmation after reviewing its impact.",
        ));
    }
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let preview = remote_service::read_remote_branch_delete_preview(
        state.remote_preflight_read.as_ref(),
        state.branch_git.as_ref(),
        state.remote_git.as_ref(),
        repo_id.clone(),
        &target.repository_path,
        &request.remote_name,
        &request.remote_branch,
    )
    .await
    .map_err(ApiError::from_remote_error)?;
    if preview.expected_remote_oid != request.expected_remote_oid
        || preview.preview_revision != request.preview_revision
    {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::WorkflowPreflightStale,
            "The remote-tracking OID or affected paths changed after review. Refresh the preview.",
        ));
    }
    if !preview.can_delete {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::WorkflowNoActiveOperation,
            "Finish the active Git operation before deleting a remote branch.",
        ));
    }
    let git_reader = state.remote_preflight_read.clone();
    let remote_commands = state.remote_commands.clone();
    let branch_git = state.branch_git.clone();
    let remote_git = state.remote_git.clone();
    let repositories = state.repositories.clone();
    let task_repo_id = repo_id.clone();
    let path = target.repository_path;
    let resource_key = target.resource_key;
    let remote_name = request.remote_name;
    let remote_branch = request.remote_branch;
    let expected_remote_oid = request.expected_remote_oid;
    let expected_revision = request.preview_revision;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            resource_key,
            "remoteBranchDelete",
            move |context| async move {
                let current = remote_service::read_remote_branch_delete_preview(
                    git_reader.as_ref(),
                    branch_git.as_ref(),
                    remote_git.as_ref(),
                    task_repo_id.clone(),
                    &path,
                    &remote_name,
                    &remote_branch,
                )
                .await
                .map_err(|_| {
                    TaskFailure::Failed(
                        "Remote branch deletion preconditions could not be rechecked. Refresh the branch preview.".into(),
                    )
                })?;
                if current.expected_remote_oid != expected_remote_oid
                    || current.preview_revision != expected_revision
                    || !current.can_delete
                {
                    return Err(TaskFailure::Failed(
                        "The reviewed remote branch or affected path set changed. Review it again before deleting.".into(),
                    ));
                }
                let task_context = context.clone();
                let delete_command = RemoteBranchDeleteCommand {
                    remote_name: current.remote_name,
                    remote_branch: current.remote_branch,
                    target_ref: current.target_ref,
                    expected_remote_oid: current.expected_remote_oid,
                };
                let result = remote_commands
                    .delete_remote_branch(&path, delete_command, context)
                    .await;
                if result.is_ok() && repositories.refresh_metadata(&task_repo_id).await.is_err() {
                    task_context
                        .log("Repository metadata refresh failed after remote branch deletion; refresh repository state.")
                        .await;
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
