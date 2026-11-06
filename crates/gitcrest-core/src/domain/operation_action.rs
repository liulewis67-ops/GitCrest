use super::{git_result::GitFailureCode, operation::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const MAX_ACTIONS_PER_OPERATION: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationActionKind {
    StartPreservedCheckout,
    ResumePreparation,
    ResumeSaving,
    ReconcileSaveCleanup,
    CompletePreparedCheckout,
    ReconcileCheckout,
    ReconcileCapture,
    ReconcileRestore,
    ResumeCapture,
    ResumeRestoration,
    RestoreNext,
}

impl OperationActionKind {
    pub const ALL: [Self; 11] = [
        Self::StartPreservedCheckout,
        Self::ResumePreparation,
        Self::ResumeSaving,
        Self::ReconcileSaveCleanup,
        Self::CompletePreparedCheckout,
        Self::ReconcileCheckout,
        Self::ReconcileCapture,
        Self::ReconcileRestore,
        Self::ResumeCapture,
        Self::ResumeRestoration,
        Self::RestoreNext,
    ];

    pub fn allowed(self, operation: &GitOperation) -> bool {
        // Only explicit checkout destinations have recovery executors today.
        // Legacy checkout and Pull records must not advertise unsupported work.
        if !operation.state.is_valid()
            || !matches!(
                operation.request.command,
                OperationCommand::CheckoutBranch { .. } | OperationCommand::CheckoutDetached { .. }
            )
        {
            return false;
        }
        let last = operation.steps.last();
        let unknown = operation.state.status == OperationStatus::RecoveryRequired
            && operation.state.wait_reason == Some(OperationWaitReason::OutcomeUnknown);
        match self {
            Self::ResumeSaving => {
                unknown
                    && matches!(
                        operation.state.phase,
                        OperationPhase::Preparing | OperationPhase::Saving
                    )
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    && operation.state.result_head_oid.is_none()
                    && operation.preservation_plan.as_ref().is_some_and(|plan| {
                        !plan.groups.is_empty() && operation.steps.len() < plan.groups.len() * 2
                    })
                    && operation.steps.len().is_multiple_of(2)
                    && operation.backups.len() == operation.steps.len() / 2
                    && operation
                        .backups
                        .iter()
                        .all(|b| b.disposition == BackupDisposition::Retained)
                    && operation
                        .steps
                        .iter()
                        .all(|s| s.status == OperationStepStatus::Verified)
                    && last.is_none_or(|s| s.kind == OperationStepKind::Clean)
            }
            Self::ReconcileSaveCleanup => {
                unknown
                    && operation.state.phase == OperationPhase::Saving
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    && operation.state.result_head_oid.is_none()
                    && operation.preservation_plan.is_some()
                    && operation.steps.len() >= 2
                    && operation.steps.len().is_multiple_of(2)
                    && operation.steps[..operation.steps.len() - 1]
                        .iter()
                        .all(|s| s.status == OperationStepStatus::Verified)
                    && last.is_some_and(|s| {
                        s.kind == OperationStepKind::Clean
                            && matches!(
                                s.status,
                                OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
                            )
                    })
            }
            Self::ResumePreparation => {
                unknown
                    && operation.state.phase == OperationPhase::Preparing
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    && operation.state.result_head_oid.is_none()
                    && operation.preservation_plan.is_none()
                    && operation.steps.is_empty()
                    && operation.backups.is_empty()
            }
            Self::StartPreservedCheckout => {
                operation.state.phase == OperationPhase::Preparing
                    && matches!(
                        operation.state.status,
                        OperationStatus::Queued | OperationStatus::Running
                    )
                    && operation.state.failure_code.is_none()
                    && operation.preservation_plan.is_none()
                    && operation.steps.is_empty()
                    && operation.backups.is_empty()
            }
            Self::CompletePreparedCheckout => {
                operation.state.phase == OperationPhase::Saving
                    && (operation.state.status == OperationStatus::Running || unknown)
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    && operation.preservation_plan.as_ref().is_some_and(|plan| {
                        !plan.groups.is_empty()
                            && operation.steps.len() == plan.groups.len() * 2
                            && operation.backups.len() == plan.groups.len()
                    })
                    && operation
                        .steps
                        .iter()
                        .all(|s| s.status == OperationStepStatus::Verified)
                    && operation
                        .backups
                        .iter()
                        .all(|b| b.disposition == BackupDisposition::Retained)
                    && last.is_some_and(|s| s.kind == OperationStepKind::Clean)
            }
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
            Self::ReconcileRestore => {
                unknown
                    && operation.state.phase == OperationPhase::Restoring
                    && operation.request.preservation == PreservationPolicy::Restore
                    && last.is_some_and(|s| {
                        s.kind == OperationStepKind::Restore
                            && matches!(
                                s.status,
                                OperationStepStatus::Unknown | OperationStepStatus::IntentRecorded
                            )
                            && s.after_fingerprint.as_deref().is_some_and(|value| {
                                value.strip_prefix("sha256:").is_some_and(|hash| {
                                    hash.len() == 64
                                        && hash
                                            .bytes()
                                            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                                })
                            })
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
            Self::ResumeRestoration => {
                unknown
                    && operation.state.phase == OperationPhase::Restoring
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    && operation.preservation_plan.is_some()
                    && operation
                        .backups
                        .iter()
                        .any(|b| b.disposition == BackupDisposition::Retained)
                    && operation
                        .steps
                        .iter()
                        .all(|s| s.status == OperationStepStatus::Verified)
                    && last.is_some_and(|s| {
                        matches!(
                            s.kind,
                            OperationStepKind::Execute | OperationStepKind::Restore
                        )
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

impl OperationActionStatus {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Accepted | Self::Running)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationAction {
    pub operation_id: String,
    pub request: OperationActionRequest,
    pub admitted_version: i64,
    pub status: OperationActionStatus,
    pub task_id: Option<String>,
    /// Captured only by the actual ResumeSaving claim, never by admission or
    /// task binding. This records the immutable boundary granted to that task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preservation_start_sequence: Option<u32>,
    pub result_version: Option<i64>,
    pub failure_code: Option<GitFailureCode>,
}

pub(crate) struct OperationActionAdmission {
    pub action: OperationAction,
    pub operation: GitOperation,
    pub created: bool,
}
