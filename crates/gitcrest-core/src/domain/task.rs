use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskStatus {
    Queued,
    Running,
    WaitingForInput,
    Succeeded,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskErrorCategory {
    Authentication,
    Network,
    GitUnavailable,
    CommandFailed,
    PushRejected,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSnapshot {
    pub(crate) task_id: String,
    pub(crate) repo_id: Option<String>,
    #[serde(default)]
    pub(crate) target_path: Option<String>,
    #[serde(default)]
    pub(crate) result_repo_id: Option<String>,
    pub(crate) operation: String,
    pub(crate) status: TaskStatus,
    pub(crate) phase: String,
    pub(crate) progress: Option<u8>,
    pub(crate) message: Option<String>,
    pub(crate) error_category: Option<TaskErrorCategory>,
    #[serde(default)]
    pub(crate) failure_code: Option<super::git_result::GitFailureCode>,
    #[serde(default)]
    pub(crate) command_exit_code: Option<i32>,
    #[serde(default)]
    pub(crate) diagnostics_truncated: bool,
    pub(crate) logs: Vec<String>,
    pub(crate) created_at_ms: u128,
    pub(crate) updated_at_ms: u128,
    pub(crate) cancel_requested: bool,
}
