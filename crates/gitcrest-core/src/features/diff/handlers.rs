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
    dto::{CommitDiffQuery, DiffDocumentDto, DiffQuery, RangeDiffQuery},
    service,
};
use crate::domain::diff::{DiffContext, DiffScope};
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
    let context: DiffContext = query.context.into();
    let repository_path = state
        .repository_targets
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
        service::read_with_context(
            &state.git_commands,
            state.diff_worktree.as_ref(),
            repo_id.clone(),
            &repository_path,
            &candidate,
            scope,
            context,
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
        return service::read_with_context(
            &state.git_commands,
            state.diff_worktree.as_ref(),
            repo_id,
            &repository_path,
            file,
            scope,
            context,
        )
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
        .repository_targets
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
        query.context.into(),
    )
    .await
    .map(DiffDocumentDto::from)
    .map(Json)
    .map_err(ApiError::from_diff_error)
}

/// A file's change between two commits, or between a commit and the working tree.
pub(super) async fn repository_range_file_diff(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<RangeDiffQuery>, QueryRejection>,
) -> Result<Json<DiffDocumentDto>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A starting commit and a repository-relative file path are required.",
        )
    })?;
    let repository_path = state
        .repository_targets
        .read_repository_path(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    service::read_range_file(
        &state.git_commands,
        repo_id,
        &repository_path,
        &query.from,
        query.to.as_deref(),
        &query.path,
        query.context.into(),
    )
    .await
    .map(DiffDocumentDto::from)
    .map(Json)
    .map_err(ApiError::from_diff_error)
}

/// One side of an image file, as the bytes of the image itself. It is read only, limited to a few
/// image types and a size cap, and sent so that a browser can neither run nor sniff it.
pub(super) async fn repository_image(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<super::images::ImageQuery>, QueryRejection>,
) -> Result<axum::response::Response, ApiError> {
    use super::images::{self, ImageError};

    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "An image path, scope and side are required.",
        )
    })?;
    let target = state
        .repository_targets
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let (bytes, media) = images::read_image(&target.repository_path, &query)
        .await
        .map_err(|error| match error {
            ImageError::InvalidRequest => ApiError::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Choose a PNG, JPEG, GIF, WebP or SVG file inside the repository.",
            ),
            ImageError::NotFound => ApiError::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryFileNotFound,
                "This version of the image does not exist.",
            ),
            ImageError::TooLarge => ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::DiffTooLarge,
                "The image is too large to compare here.",
            ),
            ImageError::GitUnavailable => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            ImageError::Failed => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::DiffUnavailable,
                "The image could not be read.",
            ),
        })?;
    Ok(axum::response::Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", media)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(
            "Content-Security-Policy",
            "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        )
        .body(axum::body::Body::from(bytes))
        .unwrap_or_default())
}
