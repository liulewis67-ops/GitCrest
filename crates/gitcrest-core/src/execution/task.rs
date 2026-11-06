use crate::domain::git_result::{GitCommandFailure, GitFailureCode};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TaskFailure {
    Failed(String),
    Cancelled,
    WaitingForInput(String),
    Diagnosed {
        failure: GitCommandFailure,
        message: String,
    },
}
impl TaskFailure {
    pub(crate) fn command_failed(message: String) -> Self {
        Self::diagnosed(GitFailureCode::CommandFailed, message)
    }

    pub(crate) fn diagnosed(code: GitFailureCode, message: impl Into<String>) -> Self {
        Self::Diagnosed {
            failure: GitCommandFailure::new(code),
            message: message.into(),
        }
    }

    pub(crate) fn with_message(self, message: impl Into<String>) -> Self {
        let message = message.into();
        match self {
            Self::Diagnosed { failure, .. } => Self::Diagnosed { failure, message },
            Self::WaitingForInput(_) => Self::WaitingForInput(message),
            Self::Failed(_) => Self::Failed(message),
            Self::Cancelled => Self::Cancelled,
        }
    }

    pub(crate) fn with_code(self, code: GitFailureCode, message: impl Into<String>) -> Self {
        let message = message.into();
        match self {
            Self::Diagnosed { mut failure, .. } => {
                failure.code = code;
                Self::Diagnosed { failure, message }
            }
            _ => Self::diagnosed(code, message),
        }
    }

    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Diagnosed { message, .. }
            | Self::Failed(message)
            | Self::WaitingForInput(message) => message,
            Self::Cancelled => "Cancelled",
        }
    }
}
