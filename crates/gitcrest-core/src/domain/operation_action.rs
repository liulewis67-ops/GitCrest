use super::{git_result::GitFailureCode, operation::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationActionKind {
    ReconcileCheckout,
    ReconcileCapture,
    ResumeCapture,
    RestoreNext,
}

impl OperationActionKind {
    pub fn allowed(self, operation: &GitOperation) -> bool {
        let last = operation.steps.last();
        let unknown = operation.state.status == OperationStatus::RecoveryRequired
            && operation.state.wait_reason == Some(OperationWaitReason::OutcomeUnknown);
        match self {
            Self::ReconcileCheckout => {
                unknown
                    && operation.state.phase == OperationPhase::Executing
                    && last.is_some_and(|s| {
                        s.kind == OperationStepKind::Execute
                            && matches!(
                                s.status,
                                OperationStepStatus::Unknown | OperationStepStatus::IntentRecorded
                            )
                    })
            }
            Self::ReconcileCapture => {
                unknown
                    && operation.state.phase == OperationPhase::Restoring
                    && last.is_some_and(|s| {
                        s.kind == OperationStepKind::CaptureIndex
                            && matches!(
                                s.status,
                                OperationStepStatus::Unknown | OperationStepStatus::IntentRecorded
                            )
                    })
            }
            Self::ResumeCapture => {
                unknown
                    && operation.state.phase == OperationPhase::Restoring
                    && last.is_some_and(|s| {
                        s.kind == OperationStepKind::CaptureIndex
                            && s.status == OperationStepStatus::Verified
                    })
            }
            Self::RestoreNext => {
                operation.state.phase == OperationPhase::Restoring
                    && operation.state.status == OperationStatus::Running
                    && last.is_some_and(|s| {
                        matches!(
                            s.kind,
                            OperationStepKind::Execute | OperationStepKind::Restore
                        ) && s.status == OperationStepStatus::Verified
                    })
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationActionRequest {
    pub request_id: String,
    pub expected_version: i64,
    pub kind: OperationActionKind,
}
impl OperationActionRequest {
    pub fn fingerprint(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(self).expect("action request serializes"))
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationActionStatus {
    Accepted,
    Running,
    Succeeded,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationAction {
    pub operation_id: String,
    pub request: OperationActionRequest,
    pub admitted_version: i64,
    pub status: OperationActionStatus,
    pub task_id: Option<String>,
    pub result_version: Option<i64>,
    pub failure_code: Option<GitFailureCode>,
}

pub(crate) struct OperationActionAdmission {
    pub action: OperationAction,
    pub operation: GitOperation,
    pub created: bool,
}
