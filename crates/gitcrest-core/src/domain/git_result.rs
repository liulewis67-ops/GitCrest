use serde::{Deserialize, Serialize};

/// Stable failure reasons; display text and retained task logs are not their source of truth.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum GitFailureCode {
    LocalChangesWouldBeOverwritten,
    UntrackedFilesWouldBeOverwritten,
    HistoryConflict,
    RestoreConflict,
    GitOperationPaused,
    AuthenticationFailed,
    RemotePolicyRejected,
    LeaseStale,
    PushRejected,
    PreconditionChanged,
    OutcomeUnknown,
    GitUnavailable,
    Network,
    TimedOut,
    CommandFailed,
}

impl GitFailureCode {
    pub(crate) fn requires_input(self) -> bool {
        matches!(
            self,
            Self::HistoryConflict | Self::RestoreConflict | Self::GitOperationPaused
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitCommandFailure {
    pub(crate) code: GitFailureCode,
    pub(crate) exit_code: Option<i32>,
    pub(crate) diagnostics_truncated: bool,
}

impl GitCommandFailure {
    pub(crate) fn new(code: GitFailureCode) -> Self {
        Self {
            code,
            exit_code: None,
            diagnostics_truncated: false,
        }
    }
}
