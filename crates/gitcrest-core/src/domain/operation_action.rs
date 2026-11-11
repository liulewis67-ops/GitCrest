use super::{git_result::GitFailureCode, operation::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const MAX_ACTIONS_PER_OPERATION: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationActionKind {
    StartPreservedCheckout,
    CancelPreparation,
    ResumePreparation,
    ResumeSaving,
    ResumeSavedCleanup,
    ReconcileSave,
    ReconcileSaveCleanup,
    CompletePreparedCheckout,
    ResumePlannedCheckout,
    AbandonPlannedCheckout,
    ResumePlannedRestoration,
    ResumePlannedPreservation,
    RestoreSourceChanges,
    RestorePartialSourceChanges,
    ReconcileCheckout,
    ReconcileCapture,
    ReconcileRestore,
    ResumeCapture,
    ResumeRestoration,
    RestoreNext,
}

impl OperationActionKind {
    pub const ALL: [Self; 20] = [
        Self::StartPreservedCheckout,
        Self::CancelPreparation,
        Self::ResumePreparation,
        Self::ResumeSaving,
        Self::ResumeSavedCleanup,
        Self::ReconcileSave,
        Self::ReconcileSaveCleanup,
        Self::CompletePreparedCheckout,
        Self::ResumePlannedCheckout,
        Self::AbandonPlannedCheckout,
        Self::ResumePlannedRestoration,
        Self::ResumePlannedPreservation,
        Self::RestoreSourceChanges,
        Self::RestorePartialSourceChanges,
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
            Self::RestorePartialSourceChanges => {
                let end = operation.backups.len() * 2;
                operation.state.phase == OperationPhase::Saving
                    && operation.state.status == OperationStatus::RecoveryRequired
                    && (unknown
                        && matches!(
                            operation.state.failure_code,
                            None | Some(GitFailureCode::OutcomeUnknown)
                        )
                        || operation.state.wait_reason == Some(OperationWaitReason::ExternalChange)
                            && operation.state.failure_code
                                == Some(GitFailureCode::PreconditionChanged))
                    && operation.state.result_head_oid.is_none()
                    && (operation.uncleaned_save_group().is_some()
                        || (operation.preservation_plan.as_ref().is_some_and(|p| {
                            !operation.backups.is_empty()
                                && operation.backups.len() < p.groups.len()
                        }) && operation.steps.get(..end).is_some_and(|prefix| {
                            prefix
                                .iter()
                                .all(|s| s.status == OperationStepStatus::Verified)
                                && prefix
                                    .last()
                                    .is_some_and(|s| s.kind == OperationStepKind::Clean)
                        }) && (operation.steps.len() == end
                            || last.is_some_and(|s| {
                                s.kind == OperationStepKind::Save
                                    && Self::ResumePlannedPreservation.allowed(operation)
                                    && s.before_fingerprint
                                        == operation.steps[end - 1].after_fingerprint
                                    && s.backup_id.as_deref()
                                        == Some(
                                            operation
                                                .preservation_shelf_id(s.sequence / 2)
                                                .as_str(),
                                        )
                            }))))
                    && operation
                        .backups
                        .iter()
                        .all(|b| b.disposition == BackupDisposition::Retained)
            }
            Self::AbandonPlannedCheckout => Self::ResumePlannedCheckout.allowed(operation),
            Self::ResumePlannedPreservation => {
                (unknown
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    || operation.state.status == OperationStatus::RecoveryRequired
                        && operation.state.wait_reason == Some(OperationWaitReason::ExternalChange)
                        && operation.state.failure_code
                            == Some(GitFailureCode::PreconditionChanged))
                    && operation.state.phase == OperationPhase::Saving
                    && operation.state.result_head_oid.is_none()
                    && operation.preservation_plan.as_ref().is_some_and(|p| {
                        !p.groups.is_empty() && operation.steps.len() <= p.groups.len() * 2
                    })
                    && operation
                        .backups
                        .iter()
                        .all(|b| b.disposition == BackupDisposition::Retained)
                    && operation.steps[..operation.steps.len().saturating_sub(1)]
                        .iter()
                        .all(|s| s.status == OperationStepStatus::Verified)
                    && last.is_some_and(|s| {
                        matches!(s.kind, OperationStepKind::Save | OperationStepKind::Clean)
                            && s.status == OperationStepStatus::Planned
                            && s.sequence as usize == operation.steps.len() - 1
                            && s.sequence.is_multiple_of(2) == (s.kind == OperationStepKind::Save)
                            && operation.backups.len()
                                == (operation.steps.len() - 1) / 2
                                    + usize::from(s.kind == OperationStepKind::Clean)
                            && s.task_id.as_deref().is_some_and(|id| !id.is_empty())
                            && s.backup_id.as_deref().is_some_and(|id| !id.is_empty())
                            && s.before_fingerprint
                                .as_deref()
                                .is_some_and(|fp| !fp.is_empty())
                            && !s.input_fingerprint.is_empty()
                            && s.after_fingerprint.is_none()
                            && s.failure_code.is_none()
                            && s.source_objects.is_none()
                    })
            }
            Self::ResumePlannedRestoration => {
                (unknown
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    || operation.state.status == OperationStatus::RecoveryRequired
                        && operation.state.wait_reason == Some(OperationWaitReason::ExternalChange)
                        && operation.state.failure_code
                            == Some(GitFailureCode::PreconditionChanged))
                    && operation.state.phase == OperationPhase::Restoring
                    && operation.state.result_head_oid.is_some()
                    && operation.restores_changes()
                    && operation.preservation_plan.as_ref().is_some_and(|p| {
                        !p.groups.is_empty()
                            && operation.restoration_saved_groups() == Some(operation.backups.len())
                    })
                    && operation
                        .backups
                        .iter()
                        .any(|b| b.disposition == BackupDisposition::Retained)
                    && operation.resolved_restore_prefix(
                        &operation.steps[..operation.steps.len().saturating_sub(1)],
                    )
                    && last.is_some_and(|s| {
                        matches!(
                            s.kind,
                            OperationStepKind::CaptureIndex | OperationStepKind::Restore
                        ) && s.status == OperationStepStatus::Planned
                            && s.sequence as usize == operation.steps.len() - 1
                            && s.task_id.as_deref().is_some_and(|id| !id.is_empty())
                            && s.before_fingerprint
                                .as_deref()
                                .is_some_and(|fp| !fp.is_empty())
                            && s.backup_id.as_deref().is_some_and(|id| {
                                operation.backups.iter().any(|b| {
                                    b.shelf_id == id && b.disposition == BackupDisposition::Retained
                                })
                            })
                            && !s.input_fingerprint.is_empty()
                            && s.after_fingerprint.is_none()
                            && s.source_objects.is_none()
                            && s.failure_code.is_none()
                    })
            }
            Self::ResumePlannedCheckout => {
                (unknown
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    || operation.state.status == OperationStatus::RecoveryRequired
                        && operation.state.wait_reason == Some(OperationWaitReason::ExternalChange)
                        && operation.state.failure_code
                            == Some(GitFailureCode::PreconditionChanged))
                    && operation.state.phase == OperationPhase::Executing
                    && operation.state.result_head_oid.is_none()
                    && operation.preservation_plan.as_ref().is_some_and(|plan| {
                        !plan.groups.is_empty()
                            && operation.steps.len() == plan.groups.len() * 2 + 1
                            && operation.backups.len() == plan.groups.len()
                    })
                    && operation
                        .backups
                        .iter()
                        .all(|b| b.disposition == BackupDisposition::Retained)
                    && operation.steps[..operation.steps.len().saturating_sub(1)]
                        .iter()
                        .all(|s| s.status == OperationStepStatus::Verified)
                    && last.is_some_and(|s| {
                        s.kind == OperationStepKind::Execute
                            && s.status == OperationStepStatus::Planned
                            && s.sequence as usize == operation.steps.len() - 1
                            && s.task_id.as_deref().is_some_and(|id| !id.is_empty())
                            && s.before_fingerprint
                                .as_deref()
                                .is_some_and(|fp| !fp.is_empty())
                            && operation
                                .steps
                                .get(operation.steps.len() - 2)
                                .is_some_and(|clean| {
                                    clean.kind == OperationStepKind::Clean
                                        && clean.after_fingerprint == s.before_fingerprint
                                })
                            && s.input_fingerprint
                                == format!(
                                    "{:x}",
                                    Sha256::digest(
                                        serde_json::to_vec(&operation.request.command)
                                            .expect("typed command serializes")
                                    )
                                )
                            && s.after_fingerprint.is_none()
                            && s.backup_id.is_none()
                            && s.source_objects.is_none()
                            && s.failure_code.is_none()
                    })
            }
            Self::RestoreSourceChanges => {
                operation.state.status == OperationStatus::RecoveryRequired
                    && (operation.state.wait_reason == Some(OperationWaitReason::ExternalChange)
                        && operation.source_recovery_failure_code()
                            == GitFailureCode::PreconditionChanged
                        || operation.state.wait_reason
                            == Some(OperationWaitReason::ExecutionFailed)
                            && operation.source_recovery_failure_code()
                                == GitFailureCode::CommandFailed)
                    && operation.state.failure_code
                        == Some(operation.source_recovery_failure_code())
                    && operation.state.result_head_oid.is_none()
                    && operation.preservation_plan.as_ref().is_some_and(|plan| {
                        !plan.groups.is_empty()
                            && operation.steps.len()
                                == plan.groups.len() * 2
                                    + usize::from(
                                        operation.state.phase == OperationPhase::Executing,
                                    )
                            && operation.backups.len() == plan.groups.len()
                    })
                    && operation.resolved_restore_prefix(&operation.steps)
                    && operation
                        .backups
                        .iter()
                        .all(|b| b.disposition == BackupDisposition::Retained)
                    && (operation.state.phase == OperationPhase::Saving
                        && last.is_some_and(|s| s.kind == OperationStepKind::Clean)
                        || operation.state.phase == OperationPhase::Executing
                            && operation.checkout_source_failure().is_some())
            }
            Self::CancelPreparation => {
                operation.state.phase == OperationPhase::Preparing
                    && matches!(
                        operation.state.status,
                        OperationStatus::Queued
                            | OperationStatus::Running
                            | OperationStatus::RecoveryRequired
                    )
                    && operation.state.result_head_oid.is_none()
                    && operation.steps.is_empty()
                    && operation.backups.is_empty()
                    && operation.state.wait_reason.is_none_or(|reason| {
                        matches!(
                            reason,
                            OperationWaitReason::OutcomeUnknown
                                | OperationWaitReason::ExternalChange
                                | OperationWaitReason::UnsupportedPreservation
                        )
                    })
            }
            Self::ResumeSavedCleanup => {
                unknown
                    && operation.state.phase == OperationPhase::Saving
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    && operation.state.result_head_oid.is_none()
                    && operation.preservation_plan.as_ref().is_some_and(|plan| {
                        !operation.steps.len().is_multiple_of(2)
                            && operation.steps.len() < plan.groups.len() * 2
                    })
                    && operation.backups.len() == operation.steps.len() / 2 + 1
                    && operation
                        .backups
                        .iter()
                        .all(|b| b.disposition == BackupDisposition::Retained)
                    && operation
                        .steps
                        .iter()
                        .all(|s| s.status == OperationStepStatus::Verified)
                    && last.is_some_and(|s| s.kind == OperationStepKind::Save)
            }
            Self::ReconcileSave => {
                unknown
                    && operation.state.phase == OperationPhase::Saving
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    && operation.state.result_head_oid.is_none()
                    && operation.preservation_plan.as_ref().is_some_and(|plan| {
                        !operation.steps.len().is_multiple_of(2)
                            && operation.steps.len() < plan.groups.len() * 2
                    })
                    && operation.backups.len() == operation.steps.len() / 2
                    && operation
                        .backups
                        .iter()
                        .all(|b| b.disposition == BackupDisposition::Retained)
                    && operation.steps[..operation.steps.len().saturating_sub(1)]
                        .iter()
                        .all(|s| s.status == OperationStepStatus::Verified)
                    && last.is_some_and(|s| {
                        s.kind == OperationStepKind::Save
                            && matches!(
                                s.status,
                                OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
                            )
                    })
            }
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
                    && operation.restores_changes()
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
                (unknown
                    && matches!(
                        operation.state.failure_code,
                        None | Some(GitFailureCode::OutcomeUnknown)
                    )
                    || operation.state.status == OperationStatus::RecoveryRequired
                        && operation.state.wait_reason == Some(OperationWaitReason::ExternalChange)
                        && operation.state.failure_code
                            == Some(GitFailureCode::PreconditionChanged)
                    || operation.state.status == OperationStatus::Running
                        && operation.state.wait_reason.is_none()
                        && operation.state.failure_code.is_none())
                    && operation.state.phase == OperationPhase::Restoring
                    && operation.preservation_plan.is_some()
                    && operation
                        .backups
                        .iter()
                        .any(|b| b.disposition == BackupDisposition::Retained)
                    && operation.resolved_restore_prefix(&operation.steps)
                    && last.is_some_and(|s| {
                        matches!(
                            s.kind,
                            OperationStepKind::Execute
                                | OperationStepKind::SourceRecovery
                                | OperationStepKind::PartialSourceRecovery
                                | OperationStepKind::Restore
                        )
                    })
            }
            Self::RestoreNext => {
                operation.state.phase == OperationPhase::Restoring
                    && operation.state.status == OperationStatus::Running
                    && last.is_some_and(|s| {
                        matches!(
                            s.kind,
                            OperationStepKind::Execute
                                | OperationStepKind::SourceRecovery
                                | OperationStepKind::PartialSourceRecovery
                                | OperationStepKind::Restore
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
    /// Captured by a continuation claim or an atomic Planned preservation
    /// handoff, never by admission/binding. The granted start is immutable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preservation_start_sequence: Option<u32>,
    /// Immutable pre-takeover checkpoint, recorded atomically with the new
    /// Planned actor. Its previous task ID remains available after handoff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_step: Option<OperationStep>,
    pub result_version: Option<i64>,
    pub failure_code: Option<GitFailureCode>,
}

pub(crate) struct OperationActionAdmission {
    pub action: OperationAction,
    pub operation: GitOperation,
    pub created: bool,
}
