use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OperationStepKind {
    Save,
    Clean,
    Execute,
    /// Read-only source observation after known non-execution of checkout.
    SourceRecovery,
    CaptureIndex,
    Restore,
    Cleanup,
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
    pub fn not_executed_checkout(&self) -> Option<&OperationStep> {
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
                && step.status == OperationStepStatus::NotExecuted
                && step.failure_code == Some(super::git_result::GitFailureCode::PreconditionChanged)
                && step.before_fingerprint == clean.after_fingerprint
                && step.after_fingerprint.is_none()
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

    pub fn resolved_restore_prefix(&self, steps: &[OperationStep]) -> bool {
        let rejected = self.not_executed_checkout();
        steps.iter().all(|step| {
            step.status == OperationStepStatus::Verified
                || rejected.is_some_and(|rejected| step == rejected)
        })
    }

    /// Structural destination marker only. Executors must also validate the
    /// immutable save prefix, receipt identity, protected objects and live Git.
    pub fn source_recovery(&self) -> Option<&OperationStep> {
        let mut prefix = self
            .preservation_plan
            .as_ref()?
            .groups
            .len()
            .checked_mul(2)?;
        if self.not_executed_checkout().is_some() {
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

    pub fn source_recovery_input(&self, before: &str) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    "sourceRecovery",
                    &self.operation_id,
                    &self.request,
                    super::git_result::GitFailureCode::PreconditionChanged,
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
