use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
mod preservation;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum OperationCommand {
    CheckoutBranch {
        name: String,
        target_oid: String,
    },
    CheckoutDetached {
        target_oid: String,
    },
    /// Legacy records remain readable but cannot authorize a checkout mode.
    Checkout {
        target: String,
        target_oid: String,
    },
    PullMerge {
        remote: String,
        branch: String,
        target_oid: String,
    },
    PullRebase {
        remote: String,
        branch: String,
        target_oid: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PreservationPolicy {
    Restore,
    KeepOnSourceBranch,
}

/// Normalized, backend-validated inputs. No credentials or raw file contents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationRequest {
    pub command: OperationCommand,
    pub source_head_oid: Option<String>,
    pub source_branch: Option<String>,
    pub changes_fingerprint: String,
    pub preservation: PreservationPolicy,
}

impl OperationRequest {
    pub fn fingerprint(&self) -> String {
        // The typed struct has a fixed field order and contains no unordered maps.
        let bytes = serde_json::to_vec(self).expect("operation request serializes");
        format!("{:x}", Sha256::digest(bytes))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationPhase {
    Preparing,
    Saving,
    Executing,
    Restoring,
    Finished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationStatus {
    Queued,
    Running,
    WaitingForInput,
    RecoveryRequired,
    Succeeded,
    Failed,
    Cancelled,
}

impl OperationStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationWaitReason {
    HistoryConflict,
    RestoreConflict,
    OutcomeUnknown,
    ExternalChange,
    UnsupportedPreservation,
    ExecutionFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationState {
    pub phase: OperationPhase,
    pub status: OperationStatus,
    pub wait_reason: Option<OperationWaitReason>,
    pub failure_code: Option<super::git_result::GitFailureCode>,
    pub result_head_oid: Option<String>,
}

impl Default for OperationState {
    fn default() -> Self {
        Self {
            phase: OperationPhase::Preparing,
            status: OperationStatus::Queued,
            wait_reason: None,
            failure_code: None,
            result_head_oid: None,
        }
    }
}

impl OperationState {
    pub fn is_valid(&self) -> bool {
        let waiting = matches!(
            self.status,
            OperationStatus::WaitingForInput | OperationStatus::RecoveryRequired
        );
        self.status.is_terminal() == (self.phase == OperationPhase::Finished)
            && waiting == self.wait_reason.is_some()
            && (self.status != OperationStatus::Succeeded || self.failure_code.is_none())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationStepStatus {
    Planned,
    IntentRecorded,
    Verified,
    Unknown,
    /// The live checkout actor proved that review failed before Git invocation.
    /// This is not inferred from an interrupted intent or an unsuccessful exit.
    NotExecuted,
    /// Git exited unsuccessfully and the live actor verified the exact clean
    /// source state. This does not claim that invocation never occurred.
    FailedAtSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationStepKind {
    Fetch,
    ReviewPull,
    Save,
    Clean,
    Execute,
    /// Read-only source observation for failure recovery or explicit cancellation.
    SourceRecovery,
    /// Source observation after abandoning an incomplete verified save prefix.
    PartialSourceRecovery,
    CaptureIndex,
    Restore,
    Cleanup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SourceRecoveryOutcome {
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationStep {
    pub sequence: u32,
    pub kind: OperationStepKind,
    pub status: OperationStepStatus,
    pub input_fingerprint: String,
    pub before_fingerprint: Option<String>,
    /// Restore records its observed post-state on the existing intent before
    /// final confirmation. The receipt is retained if confirmation is unknown.
    pub after_fingerprint: Option<String>,
    pub task_id: Option<String>,
    pub backup_id: Option<String>,
    pub failure_code: Option<super::git_result::GitFailureCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_objects: Option<SourceObjectRoots>,
    /// Only a verified SourceRecovery may carry a terminal purpose. Legacy
    /// missing values retain the failed-precondition recovery contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_recovery_outcome: Option<SourceRecoveryOutcome>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceObjectRoots {
    pub head_oid: String,
    pub index_tree_oid: String,
    pub head_reference: String,
    pub index_reference: String,
}
impl SourceObjectRoots {
    pub fn references(operation_id: &str, step: &OperationStep) -> (String, String) {
        let key = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    operation_id,
                    step.sequence,
                    &step.backup_id,
                    &step.input_fingerprint,
                    &step.before_fingerprint,
                ))
                .expect("source object identity serializes")
            )
        );
        (
            format!("refs/gitcrest/operations/source-head-{key}"),
            format!("refs/gitcrest/operations/source-index-{key}"),
        )
    }
    pub fn matches_step(&self, operation_id: &str, step: &OperationStep) -> bool {
        let (head, index) = Self::references(operation_id, step);
        self.head_reference == head
            && self.index_reference == index
            && [&self.head_oid, &self.index_tree_oid].iter().all(|oid| {
                matches!(oid.len(), 40 | 64) && oid.bytes().all(|b| b.is_ascii_hexdigit())
            })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationBackupScope {
    Index,
    WorkingTree,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BackupDisposition {
    Retained,
    Restored,
    KeptOnSource,
    SourceIntact,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationBackup {
    pub shelf_id: String,
    pub scope: OperationBackupScope,
    pub save_order: u32,
    pub restore_order: u32,
    pub base_oid: Option<String>,
    pub content_digest: String,
    pub disposition: BackupDisposition,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitOperation {
    pub operation_id: String,
    pub repo_id: String,
    pub resource_key: String,
    pub request_id: String,
    pub request: OperationRequest,
    pub state: OperationState,
    pub version: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub steps: Vec<OperationStep>,
    pub backups: Vec<OperationBackup>,
    pub preservation_plan: Option<OperationPreservationPlan>,
}

impl GitOperation {
    pub fn pull_fast_forward_input(&self, expected: &str) -> Option<String> {
        let review = self.pull_review_step()?;
        let bytes = serde_json::to_vec(&(review, expected))
            .expect("Pull fast-forward checkpoint serializes");
        Some(format!("pull-fast-forward:{:x}", Sha256::digest(bytes)))
    }

    pub fn pull_fast_forward_step(&self) -> Option<&OperationStep> {
        let step = self.steps.get(2)?;
        self.matches_pull_fast_forward_step(step).then_some(step)
    }

    pub fn matches_pull_fast_forward_step(&self, step: &OperationStep) -> bool {
        self.preservation_plan.is_none()
            && self.backups.is_empty()
            && self.pull_review_step().is_some()
            && step.sequence == 2
            && step.kind == OperationStepKind::Execute
            && step
                .input_fingerprint
                .strip_prefix("pull-fast-forward:")
                .is_some_and(|hash| {
                    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                })
            && step.before_fingerprint.as_deref() == Some(self.request.changes_fingerprint.as_str())
            && step.task_id.as_deref().is_some_and(|task| !task.is_empty())
            && step.backup_id.is_none()
            && step.source_objects.is_none()
            && step.source_recovery_outcome.is_none()
            && match step.status {
                OperationStepStatus::Planned | OperationStepStatus::IntentRecorded => {
                    step.after_fingerprint.is_none() && step.failure_code.is_none()
                }
                OperationStepStatus::Unknown => {
                    step.after_fingerprint.is_none()
                        && matches!(
                            step.failure_code,
                            None | Some(super::git_result::GitFailureCode::OutcomeUnknown)
                        )
                }
                OperationStepStatus::Verified => {
                    step.failure_code.is_none()
                        && step.after_fingerprint.as_deref().is_some_and(|after| {
                            self.pull_fast_forward_input(after).as_ref()
                                == Some(&step.input_fingerprint)
                        })
                }
                _ => false,
            }
    }

    pub fn verified_pull_target(&self) -> Option<&str> {
        self.pull_fetch_step()
            .filter(|step| step.status == OperationStepStatus::Verified)?
            .after_fingerprint
            .as_deref()
    }

    pub fn pull_review_receipt(
        &self,
        task: &str,
        plan: Option<&OperationPreservationPlan>,
    ) -> Option<OperationStep> {
        let fetched = self.verified_pull_target()?;
        if task.is_empty() || plan.is_some_and(|plan| plan.task_id != task) {
            return None;
        }
        let input = serde_json::to_vec(&("pull-review-v1", self.pull_fetch_input(), fetched))
            .expect("Pull review identity serializes");
        let result =
            serde_json::to_vec(&(fetched, task, plan)).expect("Pull protection review serializes");
        Some(OperationStep {
            sequence: 1,
            kind: OperationStepKind::ReviewPull,
            status: OperationStepStatus::Verified,
            input_fingerprint: format!("{:x}", Sha256::digest(input)),
            before_fingerprint: Some(fetched.into()),
            after_fingerprint: Some(format!("{:x}", Sha256::digest(result))),
            task_id: Some(task.into()),
            backup_id: None,
            failure_code: None,
            source_objects: None,
            source_recovery_outcome: None,
        })
    }

    pub fn pull_review_step(&self) -> Option<&OperationStep> {
        let step = self.steps.get(1)?;
        let expected =
            self.pull_review_receipt(step.task_id.as_deref()?, self.preservation_plan.as_ref())?;
        (step == &expected).then_some(step)
    }

    pub fn pull_fetch_input(&self) -> String {
        let bytes = serde_json::to_vec(&("pull-fetch-v1", &self.operation_id, &self.request))
            .expect("pull fetch identity serializes");
        format!("{:x}", Sha256::digest(bytes))
    }

    pub fn pull_fetch_ref(&self) -> String {
        format!("refs/gitcrest/operations/pull-{}", self.pull_fetch_input())
    }

    pub fn pull_fetch_step(&self) -> Option<&OperationStep> {
        let step = self.steps.first()?;
        self.matches_pull_fetch_step(step).then_some(step)
    }

    pub fn matches_pull_fetch_step(&self, step: &OperationStep) -> bool {
        (matches!(
            self.request.command,
            OperationCommand::PullMerge { .. } | OperationCommand::PullRebase { .. }
        ) && step.kind == OperationStepKind::Fetch
            && step.sequence == 0
            && step.input_fingerprint == self.pull_fetch_input()
            && step.before_fingerprint.as_deref()
                == Some(self.request.changes_fingerprint.as_str())
            && step.task_id.as_deref().is_some_and(|id| !id.is_empty())
            && step.backup_id.is_none()
            && step.source_objects.is_none()
            && if step.status == OperationStepStatus::Verified {
                step.failure_code.is_none()
                    && step.after_fingerprint.as_deref().is_some_and(|oid| {
                        matches!(oid.len(), 40 | 64) && oid.bytes().all(|b| b.is_ascii_hexdigit())
                    })
            } else {
                step.after_fingerprint.is_none()
            })
    }

    pub fn direct_checkout_input(&self, expected: &str) -> String {
        let bytes = serde_json::to_vec(&(&self.request, expected))
            .expect("direct checkout identity serializes");
        format!("direct-checkout:{:x}", Sha256::digest(bytes))
    }

    pub fn direct_checkout_step(&self) -> Option<&OperationStep> {
        let [step] = self.steps.as_slice() else {
            return None;
        };
        (self.preservation_plan.is_none()
            && self.backups.is_empty()
            && matches!(
                self.request.command,
                OperationCommand::CheckoutBranch { .. } | OperationCommand::CheckoutDetached { .. }
            )
            && self
                .request
                .source_head_oid
                .as_deref()
                .is_some_and(|head| !head.is_empty())
            && step.sequence == 0
            && step.kind == OperationStepKind::Execute
            && step.backup_id.is_none()
            && step.source_objects.is_none()
            && step.task_id.as_deref().is_some_and(|id| !id.is_empty())
            && step.before_fingerprint.as_deref()
                == Some(self.request.changes_fingerprint.as_str())
            && step
                .input_fingerprint
                .strip_prefix("direct-checkout:")
                .is_some_and(|hash| {
                    hash.len() == 64
                        && hash
                            .bytes()
                            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
                }))
        .then_some(step)
    }

    pub fn partial_source_recovery(&self) -> Option<&OperationStep> {
        let groups = self.preservation_plan.as_ref()?.groups.len();
        let saved = self.backups.len();
        if saved > groups {
            return None;
        }
        let prefix = saved.checked_mul(2)?;
        let observed = |s: &&OperationStep| {
            s.kind == OperationStepKind::PartialSourceRecovery
                && s.status == OperationStepStatus::Verified
        };
        if let Some(marker) = prefix
            .checked_sub(1)
            .and_then(|i| self.steps.get(i))
            .filter(observed)
        {
            let backup = self
                .backups
                .iter()
                .find(|b| b.save_order as usize == saved - 1)?;
            return (marker.sequence as usize == prefix - 1
                && marker.backup_id.as_deref() == Some(backup.shelf_id.as_str())
                && backup.disposition == BackupDisposition::SourceIntact
                && self.matches_uncleaned_save(saved - 1, marker.before_fingerprint.as_deref()?))
            .then_some(marker);
        }
        if let Some(intent) = self.pending_save_intent() {
            return self.steps.get(prefix + 1).filter(|s| {
                observed(s)
                    && s.sequence as usize == prefix + 1
                    && s.backup_id.is_none()
                    && s.before_fingerprint == intent.before_fingerprint
                    && s.after_fingerprint == s.before_fingerprint
                    && s.input_fingerprint
                        == self.partial_source_recovery_input(
                            intent.before_fingerprint.as_deref().unwrap_or_default(),
                        )
            });
        }
        self.steps.get(prefix).filter(|s| {
            saved > 0
                && saved < groups
                && observed(s)
                && s.sequence as usize == prefix
                && s.backup_id.is_none()
        })
    }

    /// The original intent stays in the journal. The separate receipt proves
    /// source state and artifact absence, without asserting non-invocation.
    pub fn save_intent_covered_by_source_recovery(&self) -> Option<&OperationStep> {
        let intent = self.pending_save_intent()?;
        let marker = self.partial_source_recovery()?;
        (marker.sequence == intent.sequence.checked_add(1)? && marker.backup_id.is_none())
            .then_some(intent)
    }

    pub fn restoration_saved_groups(&self) -> Option<usize> {
        if self.partial_source_recovery().is_some() {
            Some(self.backups.len())
        } else {
            Some(self.preservation_plan.as_ref()?.groups.len())
        }
    }

    pub fn partial_source_recovery_input(&self, before: &str) -> String {
        let identity = (
            "partialSourceRecovery",
            &self.operation_id,
            &self.request,
            self.preservation_plan.as_ref().map(|p| p.groups.len()),
            self.backups.len(),
            before,
        );
        let bytes = match self.pending_save_intent() {
            Some(intent) => serde_json::to_vec(&(identity, "saveArtifactAbsent", intent)),
            None => serde_json::to_vec(&identity),
        }
        .expect("partial source identity serializes");
        format!("{:x}", Sha256::digest(bytes))
    }
    pub fn checkout_source_failure(&self) -> Option<&OperationStep> {
        if let Some(step) = self.direct_checkout_step() {
            return (step.status == OperationStepStatus::NotExecuted
                && step.failure_code
                    == Some(super::git_result::GitFailureCode::PreconditionChanged)
                && step.after_fingerprint.is_none()
                || step.status == OperationStepStatus::FailedAtSource
                    && step.failure_code
                        == Some(super::git_result::GitFailureCode::CommandFailed)
                    && step.after_fingerprint == step.before_fingerprint)
                .then_some(step);
        }
        let plan = self.preservation_plan.as_ref()?;
        let prefix = plan.groups.len().checked_mul(2)?;
        let clean = self.steps.get(prefix.checked_sub(1)?)?;
        self.steps.get(prefix).filter(|step| {
            !plan.groups.is_empty()
                && self.backups.len() == plan.groups.len()
                && matches!(
                    self.request.command,
                    OperationCommand::CheckoutBranch { .. }
                        | OperationCommand::CheckoutDetached { .. }
                )
                && self.steps[..prefix]
                    .iter()
                    .all(|s| s.status == OperationStepStatus::Verified)
                && clean.kind == OperationStepKind::Clean
                && clean.after_fingerprint.is_some()
                && step.sequence as usize == prefix
                && step.kind == OperationStepKind::Execute
                && (step.status == OperationStepStatus::NotExecuted
                    && step.failure_code
                        == Some(super::git_result::GitFailureCode::PreconditionChanged)
                    && step.after_fingerprint.is_none()
                    || step.status == OperationStepStatus::FailedAtSource
                        && step.failure_code
                            == Some(super::git_result::GitFailureCode::CommandFailed)
                        && step.after_fingerprint == step.before_fingerprint)
                && step.before_fingerprint == clean.after_fingerprint
                && step.backup_id.is_none()
                && step.source_objects.is_none()
                && step.task_id.as_deref().is_some_and(|task| !task.is_empty())
                && step.input_fingerprint
                    == format!(
                        "{:x}",
                        Sha256::digest(
                            serde_json::to_vec(&self.request.command)
                                .expect("typed command serializes")
                        )
                    )
        })
    }

    pub fn not_executed_checkout(&self) -> Option<&OperationStep> {
        self.checkout_source_failure()
            .filter(|s| s.status == OperationStepStatus::NotExecuted)
    }

    pub fn source_recovery_failure_code(&self) -> super::git_result::GitFailureCode {
        self.checkout_source_failure()
            .and_then(|s| s.failure_code)
            .unwrap_or(super::git_result::GitFailureCode::PreconditionChanged)
    }

    pub fn resolved_restore_prefix(&self, steps: &[OperationStep]) -> bool {
        let rejected = self.checkout_source_failure();
        let save = self.save_intent_covered_by_source_recovery();
        steps.iter().all(|step| {
            step.status == OperationStepStatus::Verified
                || rejected.is_some_and(|rejected| step == rejected)
                || save == Some(step)
        })
    }

    /// Structural destination marker only. Executors must also validate the
    /// immutable save prefix, receipt identity, protected objects and live Git.
    pub fn source_recovery(&self) -> Option<&OperationStep> {
        if let Some(partial) = self.partial_source_recovery() {
            return Some(partial);
        }
        let mut prefix = self
            .preservation_plan
            .as_ref()?
            .groups
            .len()
            .checked_mul(2)?;
        if self.checkout_source_failure().is_some() {
            prefix = prefix.checked_add(1)?;
        }
        self.steps.get(prefix).filter(|step| {
            step.kind == OperationStepKind::SourceRecovery
                && step.status == OperationStepStatus::Verified
        })
    }

    pub fn restores_changes(&self) -> bool {
        self.request.preservation == PreservationPolicy::Restore || self.source_recovery().is_some()
    }

    pub fn source_recovery_outcome(&self) -> Option<SourceRecoveryOutcome> {
        self.source_recovery().map(|s| {
            s.source_recovery_outcome
                .unwrap_or(SourceRecoveryOutcome::Failed)
        })
    }

    pub fn source_cancellation_input(&self, before: &str) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    "sourceCancellation",
                    &self.operation_id,
                    &self.request,
                    before,
                ))
                .expect("source cancellation identity serializes")
            )
        )
    }

    pub fn source_recovery_input(&self, before: &str) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    "sourceRecovery",
                    &self.operation_id,
                    &self.request,
                    self.source_recovery_failure_code(),
                    before,
                ))
                .expect("source recovery identity serializes")
            )
        )
    }
}

/// Reviewed scope metadata only. Raw patch bodies remain in verified shelves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationPreservationPlan {
    pub source_fingerprint: String,
    /// Immutable plan creator. Continued groups keep their own real step actors.
    pub task_id: String,
    pub patch_bytes: u64,
    pub groups: Vec<OperationPreservationGroup>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationPreservationGroup {
    pub name: String,
    pub description: String,
    pub scope: OperationBackupScope,
    pub save_order: u32,
    pub restore_order: u32,
    pub selections: Vec<OperationPreservationSelection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationPreservationSelection {
    pub path: String,
    pub revision: String,
}

pub(crate) struct NewOperation {
    pub operation_id: String,
    pub repo_id: String,
    pub resource_key: String,
    pub request_id: String,
    pub request: OperationRequest,
}

/// Every journal mutation also increments the operation version in one transaction.
pub(crate) struct OperationUpdate {
    pub state: OperationState,
    pub step: Option<OperationStep>,
    pub backup: Option<OperationBackup>,
}
