use crate::{
    domain::{diff::DiffScope, git_result::GitFailureCode, operation::*, shelf::ShelfRecord},
    execution::TaskFailure,
    ports::operations::OperationStorePort,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Internal save checkpoints only. The operation executor must already own its
/// execution permit and must verify Git state after cleanup before advancing.
pub(crate) struct ShelfSaveJournal {
    pub store: Arc<dyn OperationStorePort>,
    pub operation: GitOperation,
    pub before_fingerprint: String,
    pub save_order: u32,
    pub restore_order: u32,
    pub task_id: Option<String>,
    pub(super) expected_clean_fingerprint: String,
}

impl ShelfSaveJournal {
    #[allow(dead_code)] // used by the G3 executor when preparing each save group
    pub(crate) fn for_group(
        store: Arc<dyn OperationStorePort>,
        operation: GitOperation,
        before: &super::evidence::PreservationSnapshot,
        shelf: &ShelfRecord,
        save_order: u32,
        restore_order: u32,
    ) -> Result<Self, TaskFailure> {
        if operation.repo_id != shelf.snapshot.repo_id
            || !before.matches_source(
                operation.request.source_head_oid.as_deref(),
                operation.request.source_branch.as_deref(),
            )
        {
            return Err(journal_error());
        }
        Ok(Self {
            store,
            operation,
            before_fingerprint: before.fingerprint(),
            save_order,
            restore_order,
            task_id: None,
            expected_clean_fingerprint: before
                .expected_cleanup_fingerprint(shelf)
                .ok_or_else(journal_error)?,
        })
    }

    pub(crate) fn for_recovery(
        store: Arc<dyn OperationStorePort>,
        operation: GitOperation,
    ) -> Self {
        Self {
            store,
            operation,
            before_fingerprint: String::new(),
            save_order: 0,
            restore_order: 0,
            task_id: None,
            expected_clean_fingerprint: String::new(),
        }
    }

    #[allow(dead_code)] // called after actual Git cleanup by the G3 executor
    pub(crate) async fn confirm_cleanup(
        &mut self,
        before: &super::evidence::PreservationSnapshot,
        after: &super::evidence::PreservationSnapshot,
        shelf: &ShelfRecord,
    ) -> Result<(), TaskFailure> {
        let clean = self
            .operation
            .steps
            .last()
            .filter(|step| {
                step.kind == OperationStepKind::Clean
                    && step.status == OperationStepStatus::IntentRecorded
                    && step.backup_id.as_deref() == Some(shelf.snapshot.shelf_id.as_str())
                    && step.before_fingerprint.as_deref() == Some(before.fingerprint().as_str())
            })
            .cloned()
            .ok_or_else(verification_error)?;
        if !before.matches_source(
            self.operation.request.source_head_oid.as_deref(),
            self.operation.request.source_branch.as_deref(),
        ) || !before.confirms_cleanup(after, shelf)
            || Some(clean.input_fingerprint.as_str())
                != before.expected_cleanup_fingerprint(shelf).as_deref()
            || !self.backup_matches(&clean, shelf)?
        {
            return Err(verification_error());
        }
        self.record(
            OperationStep {
                status: OperationStepStatus::Verified,
                after_fingerprint: Some(after.fingerprint()),
                ..clean
            },
            None,
        )
        .await
        .map_err(|_| verification_error())
    }

    async fn record(
        &mut self,
        step: OperationStep,
        backup: Option<OperationBackup>,
    ) -> Result<(), TaskFailure> {
        let mut state = self.operation.state.clone();
        state.phase = OperationPhase::Saving;
        state.status = OperationStatus::Running;
        state.wait_reason = None;
        state.failure_code = None;
        self.update(state, step, backup).await
    }

    async fn update(
        &mut self,
        state: OperationState,
        step: OperationStep,
        backup: Option<OperationBackup>,
    ) -> Result<(), TaskFailure> {
        let store = self.store.clone();
        let id = self.operation.operation_id.clone();
        let version = self.operation.version;
        self.operation = tokio::task::spawn_blocking(move || {
            store.update_operation(
                &id,
                version,
                OperationUpdate {
                    state,
                    step: Some(step),
                    backup,
                },
            )
        })
        .await
        .map_err(|_| journal_error())?
        .map_err(|_| journal_error())?;
        Ok(())
    }

    fn backup_matches(
        &self,
        clean: &OperationStep,
        shelf: &ShelfRecord,
    ) -> Result<bool, TaskFailure> {
        let Some(save) = self
            .operation
            .steps
            .iter()
            .find(|step| step.sequence.checked_add(1) == Some(clean.sequence))
        else {
            return Ok(false);
        };
        let before = clean
            .before_fingerprint
            .as_deref()
            .ok_or_else(verification_error)?;
        Ok(save.kind == OperationStepKind::Save
            && save.status == OperationStepStatus::Verified
            && save.backup_id == clean.backup_id
            && save.input_fingerprint == save_input(shelf, before)?
            && self.operation.backups.iter().any(|backup| {
                backup.shelf_id == shelf.snapshot.shelf_id
                    && backup.content_digest == digest(&shelf.patch)
                    && backup.disposition == BackupDisposition::Retained
            }))
    }

    pub(crate) async fn reconcile_cleanup(
        &mut self,
        after: &super::evidence::PreservationSnapshot,
        shelf: &ShelfRecord,
    ) -> Result<(), TaskFailure> {
        let clean = self
            .operation
            .steps
            .last()
            .filter(|step| {
                step.kind == OperationStepKind::Clean
                    && matches!(
                        step.status,
                        OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
                    )
                    && step.backup_id.as_deref() == Some(shelf.snapshot.shelf_id.as_str())
            })
            .cloned()
            .ok_or_else(verification_error)?;
        if self.operation.state.phase != OperationPhase::Saving
            || self.operation.state.status != OperationStatus::RecoveryRequired
            || !after.matches_source(
                self.operation.request.source_head_oid.as_deref(),
                self.operation.request.source_branch.as_deref(),
            )
            || clean.input_fingerprint != after.fingerprint()
            || !self.backup_matches(&clean, shelf)?
            || self.operation.steps.iter().any(|step| {
                step.sequence < clean.sequence && step.status != OperationStepStatus::Verified
            })
        {
            return Err(verification_error());
        }
        self.update(
            self.operation.state.clone(),
            OperationStep {
                status: OperationStepStatus::Verified,
                after_fingerprint: Some(after.fingerprint()),
                failure_code: None,
                ..clean
            },
            None,
        )
        .await
        .map_err(|_| verification_error())
    }

    pub async fn before_save(&mut self, shelf: &ShelfRecord) -> Result<(), TaskFailure> {
        let planned = self
            .operation
            .steps
            .last()
            .filter(|s| {
                s.kind == OperationStepKind::Save && s.status == OperationStepStatus::Planned
            })
            .cloned();
        let prefix =
            &self.operation.steps[..self.operation.steps.len() - usize::from(planned.is_some())];
        let expected_before = match prefix.last() {
            Some(step)
                if step.kind == OperationStepKind::Clean
                    && step.status == OperationStepStatus::Verified =>
            {
                step.after_fingerprint.as_deref()
            }
            Some(_) => return Err(journal_error()),
            None => Some(self.operation.request.changes_fingerprint.as_str()),
        };
        if self.operation.repo_id != shelf.snapshot.repo_id
            || self.operation.request.source_head_oid != shelf.snapshot.head_oid
            || self.before_fingerprint.is_empty()
            || expected_before != Some(self.before_fingerprint.as_str())
            || !matches!(
                self.operation.state.phase,
                OperationPhase::Preparing | OperationPhase::Saving
            )
            || !(matches!(
                self.operation.state.status,
                OperationStatus::Queued | OperationStatus::Running
            ) || crate::domain::operation_action::OperationActionKind::ResumeSaving
                .allowed(&self.operation))
            || prefix
                .iter()
                .any(|step| step.status != OperationStepStatus::Verified)
        {
            return Err(journal_error());
        }
        let input_fingerprint = save_input(shelf, &self.before_fingerprint)?;
        let step = OperationStep {
            sequence: prefix.len().try_into().map_err(|_| journal_error())?,
            kind: OperationStepKind::Save,
            status: OperationStepStatus::Planned,
            input_fingerprint,
            before_fingerprint: Some(self.before_fingerprint.clone()),
            after_fingerprint: None,
            task_id: self.task_id.clone(),
            backup_id: Some(shelf.snapshot.shelf_id.clone()),
            failure_code: None,
            source_recovery_outcome: None,
            source_objects: None,
        };
        if let Some(planned) = planned {
            if planned != step || self.operation.state.status != OperationStatus::Running {
                return Err(journal_error());
            }
        } else {
            self.record(step.clone(), None).await?;
        }
        self.record(
            OperationStep {
                status: OperationStepStatus::IntentRecorded,
                ..step
            },
            None,
        )
        .await
    }

    /// Confirm an existing artifact without authorizing or starting cleanup.
    /// The observer keeps the original save actor and the recovery wait.
    pub(crate) async fn reconcile_save(&mut self, shelf: &ShelfRecord) -> Result<(), TaskFailure> {
        if !crate::domain::operation_action::OperationActionKind::ReconcileSave
            .allowed(&self.operation)
        {
            return Err(verification_error());
        }
        let save = self
            .operation
            .steps
            .last()
            .cloned()
            .ok_or_else(verification_error)?;
        if save.sequence != self.save_order * 2
            || save.backup_id.as_deref() != Some(shelf.snapshot.shelf_id.as_str())
            || save.before_fingerprint.as_deref() != Some(self.before_fingerprint.as_str())
            || save.input_fingerprint != save_input(shelf, &self.before_fingerprint)?
        {
            return Err(verification_error());
        }
        let scope = match shelf.snapshot.scope {
            Some(DiffScope::Index) => OperationBackupScope::Index,
            Some(DiffScope::WorkingTree) => OperationBackupScope::WorkingTree,
            _ => return Err(verification_error()),
        };
        let backup = OperationBackup {
            shelf_id: shelf.snapshot.shelf_id.clone(),
            scope,
            save_order: self.save_order,
            restore_order: self.restore_order,
            base_oid: shelf.snapshot.head_oid.clone(),
            content_digest: digest(&shelf.patch),
            disposition: BackupDisposition::Retained,
        };
        self.update(
            self.operation.state.clone(),
            OperationStep {
                status: OperationStepStatus::Verified,
                after_fingerprint: Some(backup.content_digest.clone()),
                failure_code: None,
                ..save
            },
            Some(backup),
        )
        .await
        .map_err(|_| verification_error())
    }

    pub async fn before_cleanup(&mut self, shelf: &ShelfRecord) -> Result<(), TaskFailure> {
        if !self
            .expected_clean_fingerprint
            .strip_prefix("sha256:")
            .is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err(journal_error());
        }
        let save = self
            .operation
            .steps
            .last()
            .filter(|step| {
                step.kind == OperationStepKind::Save
                    && step.status == OperationStepStatus::IntentRecorded
                    && step.backup_id.as_deref() == Some(shelf.snapshot.shelf_id.as_str())
            })
            .cloned()
            .ok_or_else(journal_error)?;
        if save.input_fingerprint != save_input(shelf, &self.before_fingerprint)? {
            return Err(journal_error());
        }
        let scope = match shelf.snapshot.scope {
            Some(DiffScope::Index) => OperationBackupScope::Index,
            Some(DiffScope::WorkingTree) => OperationBackupScope::WorkingTree,
            _ => return Err(journal_error()),
        };
        let backup = OperationBackup {
            shelf_id: shelf.snapshot.shelf_id.clone(),
            scope,
            save_order: self.save_order,
            restore_order: self.restore_order,
            base_oid: shelf.snapshot.head_oid.clone(),
            content_digest: digest(&shelf.patch),
            disposition: BackupDisposition::Retained,
        };
        self.record(
            OperationStep {
                status: OperationStepStatus::Verified,
                after_fingerprint: Some(backup.content_digest.clone()),
                ..save.clone()
            },
            Some(backup),
        )
        .await?;
        let clean = OperationStep {
            sequence: save.sequence.checked_add(1).ok_or_else(journal_error)?,
            kind: OperationStepKind::Clean,
            input_fingerprint: self.expected_clean_fingerprint.clone(),
            status: OperationStepStatus::Planned,
            after_fingerprint: None,
            ..save
        };
        self.record(clean.clone(), None).await?;
        self.record(
            OperationStep {
                status: OperationStepStatus::IntentRecorded,
                ..clean
            },
            None,
        )
        .await
    }

    /// Begin a new cleanup owned by the actual continuation task. The existing
    /// verified Save and its original actor are immutable.
    pub(crate) async fn resume_cleanup(&mut self, shelf: &ShelfRecord) -> Result<(), TaskFailure> {
        let planned = self
            .operation
            .steps
            .last()
            .filter(|s| {
                s.kind == OperationStepKind::Clean && s.status == OperationStepStatus::Planned
            })
            .cloned();
        if !(crate::domain::operation_action::OperationActionKind::ResumeSavedCleanup
            .allowed(&self.operation)
            || planned.is_some() && self.operation.state.status == OperationStatus::Running)
            || self.task_id.as_deref().is_none_or(str::is_empty)
        {
            return Err(journal_error());
        }
        let save = self
            .operation
            .steps
            .get(
                self.operation
                    .steps
                    .len()
                    .checked_sub(1 + usize::from(planned.is_some()))
                    .ok_or_else(journal_error)?,
            )
            .cloned()
            .ok_or_else(journal_error)?;
        if save.kind != OperationStepKind::Save
            || save.status != OperationStepStatus::Verified
            || save.sequence != self.save_order * 2
            || save.backup_id.as_deref() != Some(shelf.snapshot.shelf_id.as_str())
            || save.before_fingerprint.as_deref() != Some(self.before_fingerprint.as_str())
            || save.input_fingerprint != save_input(shelf, &self.before_fingerprint)?
            || save.after_fingerprint.as_deref() != Some(digest(&shelf.patch).as_str())
            || !self.operation.backups.iter().any(|backup| {
                backup.shelf_id == shelf.snapshot.shelf_id
                    && backup.save_order == self.save_order
                    && backup.restore_order == self.restore_order
                    && backup.content_digest == digest(&shelf.patch)
                    && backup.disposition == BackupDisposition::Retained
            })
        {
            return Err(journal_error());
        }
        let clean = OperationStep {
            sequence: save.sequence.checked_add(1).ok_or_else(journal_error)?,
            kind: OperationStepKind::Clean,
            status: OperationStepStatus::Planned,
            input_fingerprint: self.expected_clean_fingerprint.clone(),
            task_id: self.task_id.clone(),
            after_fingerprint: None,
            failure_code: None,
            ..save
        };
        if let Some(planned) = planned {
            if planned != clean {
                return Err(journal_error());
            }
        } else {
            self.record(clean.clone(), None).await?;
        }
        self.record(
            OperationStep {
                status: OperationStepStatus::IntentRecorded,
                ..clean
            },
            None,
        )
        .await
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn save_input(shelf: &ShelfRecord, before: &str) -> Result<String, TaskFailure> {
    let scope = match shelf.snapshot.scope {
        Some(DiffScope::Index) => "index",
        Some(DiffScope::WorkingTree) => "workingTree",
        _ => return Err(journal_error()),
    };
    let bytes = serde_json::to_vec(&(
        &shelf.snapshot.shelf_id,
        &shelf.snapshot.repo_id,
        &shelf.snapshot.head_oid,
        &shelf.snapshot.paths,
        scope,
        before,
        digest(&shelf.patch),
    ))
    .map_err(|_| journal_error())?;
    Ok(digest(&bytes))
}
fn journal_error() -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::OutcomeUnknown, "The shelf journal checkpoint could not be confirmed. No further cleanup was started; inspect the operation and its saved copy before continuing.")
}
fn verification_error() -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::OutcomeUnknown, "Cleanup could not be verified. The operation and its backup were retained; inspect Git state before continuing.")
}
