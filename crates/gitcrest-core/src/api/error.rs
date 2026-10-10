use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

use crate::{
    domain::error::{ConflictError, RepositoryError, WorkflowError},
    features::{
        branches, commits, credentials,
        diff::DiffError,
        history,
        remotes::{self, pull, push},
        repositories::cloning::CloneError,
        shelves, staging, tags,
        tasks::TaskSubmitError,
    },
};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[allow(dead_code)]
pub(crate) enum ApiErrorCode {
    AuthUnauthorized,
    AuthForbidden,
    ApiVersionUnsupported,
    ApiRouteNotFound,
    RepositoryNotFound,
    RepositoryPathNotFound,
    RepositoryAccessDenied,
    NotARepository,
    RepositoryAlreadyInitialized,
    RepositoryInitializationFailed,
    DatabaseUnavailable,
    GitUnavailable,
    RepositoryStatusFailed,
    TaskNotFound,
    TaskQueueFull,
    TaskServiceStopping,
    RepositoryStateConflict,
    ResourceVersionStale,
    RequestInvalid,
    CloneDestinationExists,
    RepositoryFileNotFound,
    ShelfNotFound,
    DiffTooLarge,
    DiffUnavailable,
    StagingConflict,
    CommitConflict,
    CommitMessageTooLarge,
    HistoryCommitNotFound,
    HistoryUnavailable,
    HistoryTooLarge,
    BranchesUnavailable,
    BranchesTooLarge,
    BranchNameInvalid,
    BranchAlreadyExists,
    BranchRequiresCommit,
    BranchNotFound,
    BranchCurrent,
    BranchUnmerged,
    BranchWorktreeDirty,
    RemotesUnavailable,
    RemotesTooLarge,
    RemoteNameInvalid,
    RemoteUrlInvalid,
    RemoteAlreadyExists,
    RemoteNotFound,
    CredentialInputInvalid,
    CredentialsUnavailable,
    AiProviderUnavailable,
    PullPreflightUnavailable,
    PullTargetUnavailable,
    PullPreflightStale,
    PullRequiresClean,
    PushPreflightUnavailable,
    PushTargetUnavailable,
    PushPreflightStale,
    PushRequiresFetch,
    NothingToPush,
    WorkflowPreflightUnavailable,
    WorkflowPreflightStale,
    WorkflowRequiresClean,
    WorkflowRecoveryStale,
    WorkflowRecoveryNotAllowed,
    WorkflowNoActiveOperation,
    TagAlreadyExists,
    InternalError,
}

#[derive(Serialize)]
struct ApiErrorBody {
    error: ApiErrorDetails,
}

#[derive(Serialize)]
struct ApiErrorDetails {
    code: ApiErrorCode,
    message: String,
}

pub(crate) struct ApiError {
    status: StatusCode,
    code: ApiErrorCode,
    pub(crate) message: String,
}

impl ApiError {
    pub(crate) fn new(status: StatusCode, code: ApiErrorCode, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            ApiErrorCode::AuthUnauthorized,
            "A valid session bearer token is required.",
        )
    }

    pub(crate) fn forbidden() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            ApiErrorCode::AuthForbidden,
            "This window has read-only access.",
        )
    }

    pub(crate) fn unsupported_version() -> Self {
        Self::new(
            StatusCode::NOT_ACCEPTABLE,
            ApiErrorCode::ApiVersionUnsupported,
            "The requested API major version is not supported.",
        )
    }

    pub(crate) fn route_not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::ApiRouteNotFound,
            "API route was not found.",
        )
    }

    pub(crate) fn repository_not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::RepositoryNotFound,
            "Repository was not found in this session.",
        )
    }

    pub(crate) fn from_repository_error(error: RepositoryError) -> Self {
        match error {
            RepositoryError::InvalidPath => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Choose a folder to open as a Git repository.",
            ),
            RepositoryError::PathNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryPathNotFound,
                "The selected repository path no longer exists.",
            ),
            RepositoryError::PathPermissionDenied => Self::new(
                StatusCode::FORBIDDEN,
                ApiErrorCode::RepositoryAccessDenied,
                "GitCrest does not have permission to read the selected repository.",
            ),
            RepositoryError::NotRepository => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::NotARepository,
                "The selected folder is not a Git working tree.",
            ),
            RepositoryError::AlreadyRepository => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::RepositoryAlreadyInitialized,
                "This folder already contains a Git repository.",
            ),
            RepositoryError::InitializationFailed => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                ApiErrorCode::RepositoryInitializationFailed,
                "Git could not initialize this folder.",
            ),
            RepositoryError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            RepositoryError::StorageUnavailable => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::DatabaseUnavailable,
                "Repository history could not be saved. Check the application data folder.",
            ),
            RepositoryError::RepositoryNotFound => Self::repository_not_found(),
            RepositoryError::StatusFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::RepositoryStatusFailed,
                "Git could not read this repository's working tree status.",
            ),
        }
    }

    pub(crate) fn task_not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::TaskNotFound,
            "Task was not found in this session.",
        )
    }

    pub(crate) fn task_storage_unavailable() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ApiErrorCode::DatabaseUnavailable,
            "Task state could not be saved. Retry after checking the application data folder.",
        )
    }

    pub(crate) fn task_submit(error: TaskSubmitError) -> Self {
        match error {
            TaskSubmitError::QueueFull => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::TaskQueueFull,
                "The background task queue is full. Wait for current work to finish.",
            ),
            TaskSubmitError::StorageUnavailable => Self::task_storage_unavailable(),
            TaskSubmitError::ShuttingDown => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::TaskServiceStopping,
                "The application is shutting down. Retry after it restarts.",
            ),
        }
    }

    pub(crate) fn from_clone_error(error: CloneError) -> Self {
        match error {
            CloneError::InvalidRemote => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Enter a supported HTTPS or SSH Git remote without embedded credentials.",
            ),
            CloneError::InvalidTarget => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Choose an existing parent folder and a valid single folder name.",
            ),
            CloneError::ParentNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryPathNotFound,
                "The selected clone location no longer exists.",
            ),
            CloneError::ParentAccessDenied => Self::new(
                StatusCode::FORBIDDEN,
                ApiErrorCode::RepositoryAccessDenied,
                "GitCrest does not have permission to write to the selected clone location.",
            ),
            CloneError::DestinationExists => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::CloneDestinationExists,
                "The selected destination already exists. Choose another folder name.",
            ),
            CloneError::Queue(error) => Self::task_submit(error),
        }
    }

    pub(crate) fn from_diff_error(error: DiffError) -> Self {
        match error {
            DiffError::InvalidPath => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Choose a changed file inside this repository.",
            ),
            DiffError::PathNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryFileNotFound,
                "The selected file is no longer available. Refresh the working tree and try again.",
            ),
            DiffError::PermissionDenied => Self::new(
                StatusCode::FORBIDDEN,
                ApiErrorCode::RepositoryAccessDenied,
                "GitCrest does not have permission to read the selected file.",
            ),
            DiffError::TooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::DiffTooLarge,
                "This diff exceeds the 10 MiB display limit.",
            ),
            DiffError::TimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::DiffUnavailable,
                "Git did not produce this diff within 10 seconds. Refresh and try again.",
            ),
            DiffError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            DiffError::GitFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::DiffUnavailable,
                "Git could not produce this file diff. Refresh the working tree and try again.",
            ),
        }
    }

    pub(crate) fn from_conflict_error(error: ConflictError) -> Self {
        match error {
            ConflictError::InvalidPath => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "The conflict path is invalid.",
            ),
            ConflictError::FileNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryFileNotFound,
                "The conflict file is no longer present in the working tree.",
            ),
            ConflictError::TooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::DiffTooLarge,
                "Conflict text is limited to 1 MiB.",
            ),
            ConflictError::StaleRevision => Self::new(
                StatusCode::PRECONDITION_FAILED,
                ApiErrorCode::WorkflowRecoveryStale,
                "The conflict result changed after review. Refresh before writing.",
            ),
            ConflictError::UnresolvedMarkers => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::WorkflowRecoveryNotAllowed,
                "Remove all conflict markers before marking this file resolved.",
            ),
            ConflictError::NotConflicted
            | ConflictError::Binary
            | ConflictError::Io => Self::state_conflict(
                "The conflict file changed or cannot be safely accessed. Refresh conflict state.",
            ),
            ConflictError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git is unavailable for conflict resolution.",
            ),
            ConflictError::GitFailed => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::WorkflowPreflightUnavailable,
                "Git could not read or stage this conflict file.",
            ),
            ConflictError::TimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::WorkflowPreflightUnavailable,
                "Git did not finish conflict review within 10 seconds.",
            ),
        }
    }

    pub(crate) fn from_staging_error(error: staging::StagingError) -> Self {
        match error {
            staging::StagingError::InvalidRequest => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "A valid staging action and repository-relative path are required.",
            ),
            staging::StagingError::FileNotChanged => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::RepositoryFileNotFound,
                "The selected path is no longer changed. Refresh the working tree and try again.",
            ),
            staging::StagingError::FileNotStaged => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::StagingConflict,
                "The selected file has no staged changes. Refresh the working tree and try again.",
            ),
            staging::StagingError::ConflictMustBeResolvedFirst => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::StagingConflict,
                "Resolve the selected conflict before staging or unstaging this file.",
            ),
            staging::StagingError::StaleSelection => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ResourceVersionStale,
                "The diff changed after it was displayed. Refresh it and select the desired changes again.",
            ),
        }
    }

    pub(crate) fn from_shelf_error(error: shelves::ShelfError) -> Self {
        match error {
            shelves::ShelfError::InvalidName | shelves::ShelfError::InvalidDescription => {
                Self::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::RequestInvalid,
                    "Shelf names must be 1–120 characters and descriptions at most 500 characters.",
                )
            }
            shelves::ShelfError::EmptySelection => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Select at least one text change to shelve.",
            ),
            shelves::ShelfError::PatchTooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::DiffTooLarge,
                "A shelf is limited to 10 MiB of selected text changes.",
            ),
            shelves::ShelfError::MixedScopes => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "One shelf must contain changes from a single index or working-tree scope.",
            ),
            shelves::ShelfError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not check whether the shelf applies to this working tree.",
            ),
            shelves::ShelfError::GitTimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::DiffUnavailable,
                "Checking this shelf against the working tree timed out.",
            ),
        }
    }

    pub(crate) fn from_commit_error(error: commits::CommitError) -> Self {
        match error {
            commits::CommitError::EmptyMessage | commits::CommitError::MessageContainsNul => {
                Self::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::RequestInvalid,
                    "Enter a non-empty commit message without NUL characters.",
                )
            }
            commits::CommitError::MessageTooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::CommitMessageTooLarge,
                "Commit messages must be 64 KiB or smaller.",
            ),
            commits::CommitError::NoStagedChanges => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::CommitConflict,
                "Stage at least one change before committing.",
            ),
            commits::CommitError::ConflictsMustBeResolved => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::CommitConflict,
                "Resolve repository conflicts before committing.",
            ),
            commits::CommitError::AmendRequiresHead => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::CommitConflict,
                "An existing commit is required to amend.",
            ),
            commits::CommitError::InvalidSelection => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "Choose one or more valid staged diff rows to commit.",
            ),
            commits::CommitError::StaleSelection => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::ResourceVersionStale,
                "The staged diff changed. Refresh it and select changes again.",
            ),
        }
    }

    pub(crate) fn from_history_error(error: history::HistoryError) -> Self {
        match error {
            history::HistoryError::InvalidQuery | history::HistoryError::InvalidCommit => {
                Self::new(
                    StatusCode::BAD_REQUEST,
                    ApiErrorCode::RequestInvalid,
                    "The requested commit history query is invalid.",
                )
            }
            history::HistoryError::CommitNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::HistoryCommitNotFound,
                "The requested commit does not exist in this repository.",
            ),
            history::HistoryError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            history::HistoryError::TimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::HistoryUnavailable,
                "Git did not read repository history within 20 seconds.",
            ),
            history::HistoryError::TooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::HistoryTooLarge,
                "The requested history data exceeds the 8 MiB response limit.",
            ),
            history::HistoryError::GitFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::HistoryUnavailable,
                "Git could not read the requested repository history.",
            ),
        }
    }

    pub(crate) fn from_branch_error(error: branches::BranchError) -> Self {
        match error {
            branches::BranchError::InvalidName => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BranchNameInvalid,
                "The branch name is not valid according to Git ref rules.",
            ),
            branches::BranchError::NameUnchanged => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::BranchNameInvalid,
                "Choose a different branch name.",
            ),
            branches::BranchError::AlreadyExists => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::BranchAlreadyExists,
                "A local branch with this name already exists.",
            ),
            branches::BranchError::NotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::BranchNotFound,
                "The branch ref does not exist.",
            ),
            branches::BranchError::LocalNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::BranchNotFound,
                "The local branch does not exist.",
            ),
            branches::BranchError::RequiresCommit => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::BranchRequiresCommit,
                "Create an initial commit before creating a branch.",
            ),
            branches::BranchError::Current => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::BranchCurrent,
                "Switch to another branch before deleting the current branch.",
            ),
            branches::BranchError::Unmerged(unmerged) => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::BranchUnmerged,
                format!("The branch has {unmerged} commit(s) not reachable from the current branch; confirm deletion to continue."),
            ),
            branches::BranchError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            branches::BranchError::TimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::BranchesUnavailable,
                "Git did not read branch data within 20 seconds.",
            ),
            branches::BranchError::TooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::BranchesTooLarge,
                "Branch data exceeds the 8 MiB response limit.",
            ),
            branches::BranchError::GitFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::BranchesUnavailable,
                "Git could not read the repository branches.",
            ),
            branches::BranchError::StorageUnavailable => {
                Self::from_repository_error(RepositoryError::StorageUnavailable)
            }
        }
    }

    pub(crate) fn from_remote_error(error: remotes::RemoteError) -> Self {
        match error {
            remotes::RemoteError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            remotes::RemoteError::TimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::RemotesUnavailable,
                "Git did not read remote configuration within 20 seconds.",
            ),
            remotes::RemoteError::TooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                ApiErrorCode::RemotesTooLarge,
                "Remote configuration exceeds the response limit.",
            ),
            remotes::RemoteError::GitFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::RemotesUnavailable,
                "Git could not read remote configuration.",
            ),
            remotes::RemoteError::BranchNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::BranchNotFound,
                "The remote-tracking branch is unavailable. Fetch and review branches again.",
            ),
            remotes::RemoteError::InvalidName => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RemoteNameInvalid,
                "The remote name is invalid.",
            ),
            remotes::RemoteError::InvalidUrl => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RemoteUrlInvalid,
                "Enter a supported HTTPS or SSH Git remote without embedded credentials.",
            ),
        }
    }

    pub(crate) fn from_credential_error(error: credentials::CredentialError) -> Self {
        match error {
            credentials::CredentialError::InvalidInput => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::CredentialInputInvalid,
                "The credential host, username or token is invalid.",
            ),
            credentials::CredentialError::Unavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::CredentialsUnavailable,
                "The system credential store is unavailable. Unlock it or check its desktop service, then retry.",
            ),
        }
    }

    pub(crate) fn from_push_error(error: push::PushError) -> Self {
        match error {
            push::PushError::NoCurrentBranch => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::PushTargetUnavailable,
                "Push requires a current local branch.",
            ),
            push::PushError::NoUpstream => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::PushTargetUnavailable,
                "Set an upstream for the current branch before pushing.",
            ),
            push::PushError::InvalidUpstream | push::PushError::UpstreamGone => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::PushTargetUnavailable,
                "The configured upstream remote or tracking branch is unavailable. Fetch remotes and review the branch upstream.",
            ),
            push::PushError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git is unavailable for push preflight.",
            ),
            push::PushError::TimedOut | push::PushError::TooLarge | push::PushError::GitFailed => {
                Self::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    ApiErrorCode::PushPreflightUnavailable,
                    "Push preflight could not be completed. Refresh repository state and retry.",
                )
            }
        }
    }

    pub(crate) fn from_pull_error(error: pull::PullError) -> Self {
        match error {
            pull::PullError::NoCurrentBranch
            | pull::PullError::NoUpstream
            | pull::PullError::InvalidUpstream
            | pull::PullError::UpstreamGone => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::PullTargetUnavailable,
                "Pull requires a current branch with a configured, fetched upstream. Review branch and remote settings first.",
            ),
            pull::PullError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git is unavailable for pull preflight.",
            ),
            pull::PullError::TimedOut | pull::PullError::TooLarge | pull::PullError::GitFailed => {
                Self::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    ApiErrorCode::PullPreflightUnavailable,
                    "Pull preflight could not be completed. Refresh repository state and retry.",
                )
            }
        }
    }

    pub(crate) fn from_workflow_error(error: WorkflowError) -> Self {
        match error {
            WorkflowError::InvalidTarget => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "A merge, cherry-pick, or revert target must be a hexadecimal commit ID.",
            ),
            WorkflowError::CommitNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::HistoryCommitNotFound,
                "The requested commit does not exist in this repository.",
            ),
            WorkflowError::NoActiveOperation => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::WorkflowNoActiveOperation,
                "The waiting task no longer has a merge, cherry-pick, or revert operation to recover.",
            ),
            WorkflowError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git is unavailable for workflow preflight.",
            ),
            WorkflowError::TimedOut
            | WorkflowError::TooLarge
            | WorkflowError::GitFailed => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::WorkflowPreflightUnavailable,
                "Workflow preflight could not be completed. Refresh repository state and retry.",
            ),
        }
    }

    pub(crate) fn from_tag_error(error: tags::TagError) -> Self {
        match error {
            tags::TagError::Invalid => Self::new(
                StatusCode::BAD_REQUEST,
                ApiErrorCode::RequestInvalid,
                "The tag name, commit ID, or annotation is invalid.",
            ),
            tags::TagError::AlreadyExists => Self::new(
                StatusCode::CONFLICT,
                ApiErrorCode::TagAlreadyExists,
                "A tag with this name already exists. Choose a new name.",
            ),
            tags::TagError::CommitNotFound => Self::new(
                StatusCode::NOT_FOUND,
                ApiErrorCode::HistoryCommitNotFound,
                "The requested commit does not exist in this repository.",
            ),
            tags::TagError::GitUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorCode::GitUnavailable,
                "Git could not be started. Install Git or check that it is on PATH.",
            ),
            tags::TagError::TimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                ApiErrorCode::HistoryUnavailable,
                "Git did not create the tag within 10 seconds.",
            ),
            tags::TagError::GitFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorCode::HistoryUnavailable,
                "Git could not create the requested tag.",
            ),
        }
    }

    #[allow(dead_code)]
    pub(crate) fn state_conflict(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            ApiErrorCode::RepositoryStateConflict,
            message,
        )
    }

    #[allow(dead_code)]
    pub(crate) fn stale_resource() -> Self {
        Self::new(
            StatusCode::PRECONDITION_FAILED,
            ApiErrorCode::ResourceVersionStale,
            "The resource changed since it was read. Refresh and retry.",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ApiErrorBody {
            error: ApiErrorDetails {
                code: self.code,
                message: self.message,
            },
        };
        (self.status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::json;

    use crate::domain::error::RepositoryError;

    use super::*;

    #[test]
    fn repository_access_denied_uses_forbidden_status_and_stable_error_contract() {
        let error = ApiError::from_repository_error(RepositoryError::PathPermissionDenied);

        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(
            serde_json::to_value(error.code).unwrap(),
            json!("REPOSITORY_ACCESS_DENIED")
        );
        assert_eq!(
            error.message,
            "GitCrest does not have permission to read the selected repository."
        );
    }

    #[test]
    fn repository_initialization_failure_uses_unprocessable_status_and_actionable_message() {
        let error = ApiError::from_repository_error(RepositoryError::InitializationFailed);

        assert_eq!(error.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            serde_json::to_value(error.code).unwrap(),
            json!("REPOSITORY_INITIALIZATION_FAILED")
        );
        assert_eq!(error.message, "Git could not initialize this folder.");
    }
}
