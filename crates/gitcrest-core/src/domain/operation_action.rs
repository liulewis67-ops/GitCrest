use super::{git_result::GitFailureCode, operation::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const MAX_ACTIONS_PER_OPERATION: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationActionKind {
    PreparePull,
    ReconcilePullFetch,
    ReviewFetchedPull,
    PreservePull,
    FastForwardPull,
    MergePull,
    ReconcileCompletedPullMerge,
    RebasePull,
    ReconcileCompletedPullRebase,
    ReconcilePullMergeConflict,
    ContinuePullMerge,
    ReconcileContinuedPullMerge,
    AbortPullMerge,
    ReconcileAbortedPullMerge,
    ReconcilePullFastForward,
    StartPreservedCheckout,
    CancelPreparation,
    CancelPreservedCheckout,
    CancelPreservedPull,
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
    pub fn matches_merge_resolution(self, recorded: bool, abort: bool) -> bool {
        match self {
            Self::ReconcileContinuedPullMerge => recorded && !abort,
            Self::ReconcileAbortedPullMerge => abort,
            Self::AbortPullMerge | Self::ContinuePullMerge | Self::ReconcilePullMergeConflict => {
                !recorded && !abort
            }
            _ => true,
        }
    }
    pub const ALL: [Self; 37] = [
        Self::PreparePull,
        Self::ReconcilePullFetch,
        Self::ReviewFetchedPull,
        Self::PreservePull,
        Self::FastForwardPull,
        Self::MergePull,
        Self::ReconcileCompletedPullMerge,
        Self::RebasePull,
        Self::ReconcileCompletedPullRebase,
        Self::ReconcilePullMergeConflict,
        Self::ContinuePullMerge,
        Self::ReconcileContinuedPullMerge,
        Self::AbortPullMerge,
        Self::ReconcileAbortedPullMerge,
        Self::ReconcilePullFastForward,
        Self::StartPreservedCheckout,
        Self::CancelPreparation,
        Self::CancelPreservedCheckout,
        Self::CancelPreservedPull,
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
        if matches!(self, Self::ContinuePullMerge | Self::AbortPullMerge) {
            return operation.state.status == OperationStatus::WaitingForInput
                && operation.state.wait_reason == Some(OperationWaitReason::HistoryConflict)
                && operation
                    .pending_pull_merge()
                    .is_some_and(|step| step.after_fingerprint.is_none());
        }
        if matches!(
            self,
            Self::ReconcilePullMergeConflict
                | Self::ReconcileCompletedPullMerge
                | Self::ReconcileContinuedPullMerge
                | Self::ReconcileAbortedPullMerge
        ) {
            return operation.state.status == OperationStatus::RecoveryRequired
                && operation.state.wait_reason == Some(OperationWaitReason::OutcomeUnknown)
                && operation.pending_pull_merge().is_some_and(|step| {
                    step.after_fingerprint.is_some() == (self == Self::ReconcileCompletedPullMerge)
                });
        }
        if self == Self::ReconcileCompletedPullRebase {
            return operation.state.status == OperationStatus::RecoveryRequired
                && operation.state.wait_reason == Some(OperationWaitReason::OutcomeUnknown)
                && operation.pending_divergent_pull().is_some_and(|step| {
                    operation.pull_rebase_step(step) && step.after_fingerprint.is_some()
                });
        }
        if self == Self::RebasePull {
            return matches!(
                operation.request.command,
                OperationCommand::PullRebase { .. }
            ) && Self::FastForwardPull.allowed(operation);
        }
        if self == Self::MergePull {
            return matches!(
                operation.request.command,
                OperationCommand::PullMerge { .. }
            ) && Self::FastForwardPull.allowed(operation);
        }
        if matches!(
            operation.request.command,
            OperationCommand::PullMerge { .. } | OperationCommand::PullRebase { .. }
        ) {
            if operation.preservation_plan.is_some() && operation.state.is_valid() {
                if self == Self::CancelPreservedPull {
                    let groups = operation.backups.len();
                    return operation.state.phase == OperationPhase::Saving
                        && matches!(
                            operation.state.status,
                            OperationStatus::Running | OperationStatus::RecoveryRequired
                        )
                        && operation.state.result_head_oid.is_none()
                        && operation.pull_execution_sequence().is_some_and(|sequence| {
                            sequence == 2 + groups * 2
                                && if operation.steps.len() == sequence {
                                    operation.verified_saved_prefix(groups).is_some()
                                } else {
                                    operation.steps.len() == sequence + 1
                                        && operation.pull_integration_step().is_some_and(|step| {
                                            step.status == OperationStepStatus::Planned
                                        })
                                        && operation.backups.iter().all(|backup| {
                                            backup.disposition == BackupDisposition::Retained
                                        })
                                }
                        });
                }
                if self == Self::FastForwardPull {
                    let groups = operation.backups.len();
                    return operation.state.phase == OperationPhase::Saving
                        && matches!(
                            operation.state.status,
                            OperationStatus::Running | OperationStatus::RecoveryRequired
                        )
                        && operation.state.result_head_oid.is_none()
                        && operation.pull_execution_sequence() == Some(operation.steps.len())
                        && operation.verified_saved_prefix(groups).is_some();
                }
                if self == Self::ReconcilePullFastForward {
                    return operation.state.phase == OperationPhase::Executing
                        && operation.state.status == OperationStatus::RecoveryRequired
                        && operation.state.wait_reason
                            == Some(OperationWaitReason::OutcomeUnknown)
                        && operation.state.result_head_oid.is_none()
                        && operation.pull_integration_step().is_some_and(|step| {
                            operation.steps.last() == Some(step)
                                && !operation.divergent_pull_step(step)
                                && matches!(
                                    step.status,
                                    OperationStepStatus::IntentRecorded
                                        | OperationStepStatus::Unknown
                                )
                        });
                }
                if operation.state.phase == OperationPhase::Restoring {
                    if operation.source_recovery_outcome() == Some(SourceRecoveryOutcome::Cancelled)
                    {
                        return operation.state.result_head_oid
                            == operation.request.source_head_oid
                            && self.restoration_allowed(operation);
                    }
                    return operation.pull_integration_step().is_some_and(|step| {
                        step.status == OperationStepStatus::Verified
                            && operation.state.result_head_oid.as_deref()
                                == operation.pull_integration_head(step)
                    }) && self.restoration_allowed(operation);
                }
            }
            if matches!(self, Self::ReconcileSave | Self::ResumeSavedCleanup) {
                return operation.state.is_valid()
                    && operation.pull_review_step().is_some()
                    && self.saved_cleanup_boundary(operation, 2);
            }
            if matches!(self, Self::PreservePull | Self::ReconcileSaveCleanup) {
                return operation.state.is_valid()
                    && operation.state.result_head_oid.is_none()
                    && operation.pull_review_step().is_some()
                    && operation.preservation_plan.as_ref().is_some_and(|plan| {
                        let groups = operation.backups.len();
                        if self == Self::PreservePull {
                            matches!(
                                operation.state.status,
                                OperationStatus::Queued
                                    | OperationStatus::Running
                                    | OperationStatus::RecoveryRequired
                            ) && groups < plan.groups.len()
                                && operation.steps.len() == 2 + groups * 2
                                && match operation.state.phase {
                                    OperationPhase::Preparing => groups == 0,
                                    OperationPhase::Saving => {
                                        operation.verified_saved_prefix(groups).is_some()
                                    }
                                    _ => false,
                                }
                        } else {
                            operation.state.phase == OperationPhase::Saving
                                && operation.state.status == OperationStatus::RecoveryRequired
                                && operation.state.wait_reason
                                    == Some(OperationWaitReason::OutcomeUnknown)
                                && groups > 0
                                && groups <= plan.groups.len()
                                && operation.steps.len() == 2 + groups * 2
                                && operation.steps.last().is_some_and(|step| {
                                    step.kind == OperationStepKind::Clean
                                        && matches!(
                                            step.status,
                                            OperationStepStatus::IntentRecorded
                                                | OperationStepStatus::Unknown
                                        )
                                })
                        }
                    });
            }
            return operation.state.is_valid()
                && (operation.state.phase == OperationPhase::Preparing
                    || self == Self::ReconcilePullFastForward
                        && operation.state.phase == OperationPhase::Executing)
                && operation.state.result_head_oid.is_none()
                && operation.backups.is_empty()
                && match self {
                    Self::PreparePull => {
                        operation.steps.is_empty()
                            && operation.preservation_plan.is_none()
                            && operation.state.failure_code.is_none()
                            && matches!(
                                operation.state.status,
                                OperationStatus::Queued | OperationStatus::Running
                            )
                    }
                    Self::ReconcilePullFetch => {
                        operation.preservation_plan.is_none()
                            && operation.state.status == OperationStatus::RecoveryRequired
                            && operation.state.wait_reason
                                == Some(OperationWaitReason::OutcomeUnknown)
                            && operation.steps.len() == 1
                            && operation.pull_fetch_step().is_some_and(|step| {
                                matches!(
                                    step.status,
                                    OperationStepStatus::IntentRecorded
                                        | OperationStepStatus::Unknown
                                ) && step.after_fingerprint.is_none()
                            })
                    }
                    Self::ReviewFetchedPull => {
                        operation.preservation_plan.is_none()
                            && operation.steps.len() == 1
                            && operation.verified_pull_target().is_some()
                    }
                    Self::FastForwardPull => {
                        operation.preservation_plan.is_none()
                            && operation.steps.len() == 2
                            && operation.pull_review_step().is_some()
                    }
                    Self::ReconcilePullFastForward => {
                        operation.state.phase == OperationPhase::Executing
                            && operation.state.status == OperationStatus::RecoveryRequired
                            && operation.state.wait_reason
                                == Some(OperationWaitReason::OutcomeUnknown)
                            && operation.steps.len() == 3
                            && operation.pull_integration_step().is_some_and(|step| {
                                !operation.divergent_pull_step(step)
                                    && matches!(
                                        step.status,
                                        OperationStepStatus::IntentRecorded
                                            | OperationStepStatus::Unknown
                                    )
                            })
                    }
                    Self::CancelPreparation => match operation.steps.len() {
                        0 => operation.preservation_plan.is_none(),
                        1 => {
                            operation.preservation_plan.is_none()
                                && operation.pull_fetch_step().is_some_and(|step| {
                                    matches!(
                                        step.status,
                                        OperationStepStatus::Planned
                                            | OperationStepStatus::Verified
                                    )
                                })
                        }
                        2 => operation.pull_review_step().is_some(),
                        3 => operation
                            .pull_integration_step()
                            .is_some_and(|step| step.status == OperationStepStatus::Planned),
                        _ => false,
                    },
                    _ => false,
                };
        }
        // Checkout recovery requires an explicit branch or detached destination.
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
            Self::PreparePull
            | Self::MergePull
            | Self::ReconcileCompletedPullMerge
            | Self::RebasePull
            | Self::ReconcileCompletedPullRebase
            | Self::ReconcilePullMergeConflict
            | Self::ContinuePullMerge
            | Self::ReconcileContinuedPullMerge
            | Self::AbortPullMerge
            | Self::ReconcileAbortedPullMerge
            | Self::CancelPreservedPull
            | Self::ReconcilePullFetch
            | Self::ReviewFetchedPull
            | Self::PreservePull
            | Self::FastForwardPull
            | Self::ReconcilePullFastForward => false,
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
                        || (Self::ReconcileSave.allowed(operation)
                            && operation.pending_save_intent().is_some())
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
            Self::CancelPreservedCheckout => {
                operation.direct_checkout_step().is_none()
                    && operation.state.result_head_oid.is_none()
                    && operation
                        .steps
                        .iter()
                        .all(|s| s.source_recovery_outcome.is_none())
                    && (Self::CompletePreparedCheckout.allowed(operation)
                        || Self::ResumePlannedCheckout.allowed(operation))
            }
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
                            && s.source_recovery_outcome.is_none()
                    })
            }
            Self::ResumePlannedCheckout => {
                let direct = operation.direct_checkout_step().is_some();
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
                    && (direct
                        || operation.preservation_plan.as_ref().is_some_and(|plan| {
                            !plan.groups.is_empty()
                                && operation.steps.len() == plan.groups.len() * 2 + 1
                                && operation.backups.len() == plan.groups.len()
                        }))
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
                            && (direct
                                || operation.steps.get(operation.steps.len() - 2).is_some_and(
                                    |clean| {
                                        clean.kind == OperationStepKind::Clean
                                            && clean.after_fingerprint == s.before_fingerprint
                                    },
                                ) && s.input_fingerprint
                                    == format!(
                                        "{:x}",
                                        Sha256::digest(
                                            serde_json::to_vec(&operation.request.command)
                                                .expect("typed command serializes")
                                        )
                                    ))
                            && s.after_fingerprint.is_none()
                            && s.backup_id.is_none()
                            && s.source_objects.is_none()
                            && s.source_recovery_outcome.is_none()
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
            Self::ResumeSavedCleanup | Self::ReconcileSave => {
                self.saved_cleanup_boundary(operation, 0)
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
            Self::ReconcileCapture
            | Self::ReconcileRestore
            | Self::ResumeCapture
            | Self::ResumeRestoration
            | Self::RestoreNext
            | Self::ResumePlannedRestoration => self.restoration_allowed(operation),
        }
    }
    fn restoration_allowed(self, operation: &GitOperation) -> bool {
        let last = operation.steps.last();
        let unknown = operation.state.status == OperationStatus::RecoveryRequired
            && operation.state.wait_reason == Some(OperationWaitReason::OutcomeUnknown);
        match self {
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
                            && s.source_recovery_outcome.is_none()
                            && s.failure_code.is_none()
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
            _ => false,
        }
    }
    fn saved_cleanup_boundary(self, operation: &GitOperation, offset: usize) -> bool {
        let Some((save, previous)) = operation.steps.split_last() else {
            return false;
        };
        let Some(sequence) = previous.len().checked_sub(offset) else {
            return false;
        };
        let verified = self == Self::ResumeSavedCleanup;
        operation.state.phase == OperationPhase::Saving
            && operation.state.status == OperationStatus::RecoveryRequired
            && operation.state.wait_reason == Some(OperationWaitReason::OutcomeUnknown)
            && matches!(
                operation.state.failure_code,
                None | Some(GitFailureCode::OutcomeUnknown)
            )
            && operation.state.result_head_oid.is_none()
            && sequence.is_multiple_of(2)
            && operation
                .preservation_plan
                .as_ref()
                .is_some_and(|plan| sequence / 2 < plan.groups.len())
            && operation.backups.len() == sequence / 2 + usize::from(verified)
            && operation
                .backups
                .iter()
                .all(|b| b.disposition == BackupDisposition::Retained)
            && previous
                .iter()
                .all(|step| step.status == OperationStepStatus::Verified)
            && save.kind == OperationStepKind::Save
            && if verified {
                save.status == OperationStepStatus::Verified
            } else {
                matches!(
                    save.status,
                    OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
                )
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
    /// Evidence committed by the claimed continuation before invoking Git.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_resolution_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_abort_intent: Option<String>,
    pub result_version: Option<i64>,
    pub failure_code: Option<GitFailureCode>,
}

pub(crate) struct OperationActionAdmission {
    pub action: OperationAction,
    pub operation: GitOperation,
    pub created: bool,
}
