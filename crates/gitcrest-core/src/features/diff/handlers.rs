use axum::{
    extract::{rejection::QueryRejection, Path, Query, State},
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    features::history,
    ports::repository::RepositoryPathPort,
    AppState,
};

use super::{
    dto::{CommitDiffQuery, DiffDocumentDto, DiffQuery},
    service,
};
use crate::domain::diff::DiffScope;
use crate::domain::status::{ChangeCategory, ChangeKind, StatusFile};

pub(super) async fn repository_diff(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<DiffQuery>, QueryRejection>,
) -> Result<Json<DiffDocumentDto>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A changed file path and diff scope are required.",
        )
    })?;
    let scope: DiffScope = query.scope.into();
    let repository_path = state
        .repository_paths
        .read_repository_path(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let candidate = StatusFile {
        path: query.path.clone(),
        original_path: None,
        index_status: ".".into(),
        worktree_status: "M".into(),
        kind: ChangeKind::Modified,
        categories: vec![match scope {
            DiffScope::Index => ChangeCategory::Staged,
            DiffScope::WorkingTree | DiffScope::Commit => ChangeCategory::Unstaged,
        }],
        mode_changed: false,
    };
    let (snapshot, candidate_diff) = tokio::join!(
        state
            .status
            .snapshot_paths(&repo_id, std::slice::from_ref(&query.path),),
        service::read(
            &state.git_commands,
            repo_id.clone(),
            &repository_path,
            &candidate,
            scope,
        ),
    );
    let snapshot = snapshot.map_err(ApiError::from_repository_error)?;
    let file = snapshot
        .files
        .iter()
        .find(|file| file.path == query.path)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryFileNotFound,
                "The selected path is not present in the latest change snapshot.",
            )
        })?;
    if scope == DiffScope::Commit
        || file.original_path.is_some()
        || file.categories.iter().any(|category| {
            matches!(
                category,
                ChangeCategory::Untracked | ChangeCategory::Ignored | ChangeCategory::Conflicted
            )
        })
    {
        return service::read(&state.git_commands, repo_id, &repository_path, file, scope)
            .await
            .map(DiffDocumentDto::from)
            .map(Json)
            .map_err(ApiError::from_diff_error);
    }
    let mut document = candidate_diff.map_err(ApiError::from_diff_error)?;
    document.change_kind = file.kind.clone();
    document.original_path = file.original_path.clone();
    Ok(Json(document.into()))
}

pub(super) async fn repository_commit_file_diff(
    State(state): State<AppState>,
    Path((repo_id, oid)): Path<(String, String)>,
    query: Result<Query<CommitDiffQuery>, QueryRejection>,
) -> Result<Json<DiffDocumentDto>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A repository-relative file path is required.",
        )
    })?;
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let commit = history::read_commit(repo_id.clone(), &target.repository_path, &oid)
        .await
        .map_err(ApiError::from_history_error)?;
    if !commit.files.iter().any(|file| file.path == query.path) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::RepositoryFileNotFound,
            "The selected path is not changed by this commit.",
        ));
    }
    service::read_commit_file(
        &state.git_commands,
        repo_id,
        &target.repository_path,
        &oid,
        commit.parents.first().map(String::as_str),
        &query.path,
    )
    .await
    .map(DiffDocumentDto::from)
    .map(Json)
    .map_err(ApiError::from_diff_error)
}
