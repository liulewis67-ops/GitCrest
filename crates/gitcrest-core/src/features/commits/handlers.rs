use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    Json,
};

use crate::domain::diff::DiffScope;
use crate::{
    api::error::{ApiError, ApiErrorCode},
    features::{
        commits,
        diff::{self, DiffError},
        status,
        tasks::{TaskFailure, TaskSnapshot},
    },
    state::AppState,
};
enum CommitPatchError {
    Invalid,
    Stale,
    Diff(DiffError),
}

async fn selected_commit_patch(
    repo_id: &str,
    repository_path: &std::path::Path,
    snapshot: &status::StatusSnapshot,
    selections: &[commits::CommitSelection],
) -> Result<Option<Vec<u8>>, CommitPatchError> {
    if selections.is_empty() {
        return Ok(None);
    }
    commits::validate_selection_shape(selections).map_err(|_| CommitPatchError::Invalid)?;
    let mut selected_patch = Vec::new();
    for selection in selections {
        let file = snapshot
            .files
            .iter()
            .find(|file| file.path == selection.path)
            .filter(|file| file.categories.contains(&status::ChangeCategory::Staged))
            .ok_or(CommitPatchError::Invalid)?;
        let current =
            diff::read_with_patch(repo_id.to_owned(), repository_path, file, DiffScope::Index)
                .await
                .map_err(CommitPatchError::Diff)?;
        if current.document.revision != selection.revision {
            return Err(CommitPatchError::Stale);
        }
        let diff_selections = selection
            .selections
            .iter()
            .cloned()
            .map(Into::into)
            .collect::<Vec<_>>();
        selected_patch.extend(
            diff::select_changes(&current, &diff_selections)
                .map_err(|_| CommitPatchError::Invalid)?,
        );
    }
    Ok(Some(selected_patch))
}

fn map_commit_patch_error(error: CommitPatchError) -> ApiError {
    match error {
        CommitPatchError::Invalid => {
            ApiError::from_commit_error(commits::CommitError::InvalidSelection)
        }
        CommitPatchError::Stale => {
            ApiError::from_commit_error(commits::CommitError::StaleSelection)
        }
        CommitPatchError::Diff(error) => ApiError::from_diff_error(error),
    }
}

pub(super) async fn commit_repository(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<commits::CommitRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<TaskSnapshot>), ApiError> {
    let Json(request) = request.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "A commit message is required.",
        )
    })?;
    commits::validate_message(&request.message).map_err(ApiError::from_commit_error)?;
    if request.amend
        && state
            .repositories
            .refresh_metadata(&repo_id)
            .await
            .map_err(ApiError::from_repository_error)?
            .head
            .is_none()
    {
        return Err(ApiError::from_commit_error(
            commits::CommitError::AmendRequiresHead,
        ));
    }
    let target = state
        .repositories
        .task_target(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    let snapshot = state
        .status
        .snapshot(&repo_id)
        .await
        .map_err(ApiError::from_repository_error)?;
    commits::validate_snapshot(&snapshot).map_err(ApiError::from_commit_error)?;
    commits::validate_selection_shape(&request.selections).map_err(ApiError::from_commit_error)?;
    let _selected_patch = selected_commit_patch(
        &repo_id,
        &target.repository_path,
        &snapshot,
        &request.selections,
    )
    .await
    .map_err(map_commit_patch_error)?;

    let repositories = state.repositories.clone();
    let status_service = state.status.clone();
    let commands = state.git_commands.clone();
    let task_repo_id = repo_id.clone();
    let repository_path = target.repository_path;
    let message = request.message;
    let amend = request.amend;
    let sign_off = request.sign_off;
    let sign = request.sign;
    let commit_selections = request.selections;
    let task = state
        .tasks
        .submit(
            Some(repo_id),
            None,
            target.resource_key,
            "commit",
            move |context| async move {
                let before = repositories
                    .refresh_metadata(&task_repo_id)
                    .await
                    .map_err(|_| {
                        TaskFailure::Failed(
                            "Could not read repository metadata before committing".into(),
                        )
                    })?;
                let current = status_service.snapshot(&task_repo_id).await.map_err(|_| {
                    TaskFailure::Failed(
                        "Could not refresh repository status before committing".into(),
                    )
                })?;
                commits::validate_snapshot(&current).map_err(|error| {
                    TaskFailure::Failed(format!("Commit precondition changed: {error:?}"))
                })?;
                let selected_patch = selected_commit_patch(
                    &task_repo_id,
                    &repository_path,
                    &current,
                    &commit_selections,
                )
                .await
                .map_err(|error| {
                    TaskFailure::Failed(match error {
                        CommitPatchError::Invalid => "Commit selection is no longer valid".into(),
                        CommitPatchError::Stale => {
                            "The staged diff became stale; refresh and select changes again".into()
                        }
                        CommitPatchError::Diff(_) => {
                            "Could not refresh the selected staged diff before committing".into()
                        }
                    })
                })?;
                if amend && before.head.is_none() {
                    return Err(TaskFailure::Failed(
                        "An existing commit is required to amend".into(),
                    ));
                }
                let result = commands
                    .execute_commit(
                        &repository_path,
                        message,
                        amend,
                        sign_off,
                        sign,
                        selected_patch,
                        before.head.clone(),
                        context,
                    )
                    .await;
                let after = repositories.refresh_metadata(&task_repo_id).await;
                if let Ok(after) = after {
                    if before.head != after.head && after.head.is_some() {
                        return Ok(None);
                    }
                }
                result.map(|()| None)
            },
        )
        .await
        .map_err(ApiError::task_submit)?;
    Ok((StatusCode::ACCEPTED, Json(task)))
}
