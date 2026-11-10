use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    domain::{operation::*, operation_action::OperationActionKind},
    ports::operations::{OperationStoreError as Error, OperationStorePort},
};

use super::{now_ms, RepositoryStore};

const COLUMNS: &str = "operation_id, repo_id, resource_key, request_id, request_json, \
    state_json, version, created_at_ms, updated_at_ms";
const MAX_ACTIVE_OPERATIONS: i64 = 64;
mod actions;
mod plans;
mod queries;

fn unavailable<T>(_: T) -> Error {
    Error::Unavailable
}

fn encode(value: &impl Serialize) -> Result<String, Error> {
    serde_json::to_string(value).map_err(unavailable)
}

fn decode<T: DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    let json: String = row.get(index)?;
    serde_json::from_str(&json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<GitOperation> {
    Ok(GitOperation {
        operation_id: row.get(0)?,
        repo_id: row.get(1)?,
        resource_key: row.get(2)?,
        request_id: row.get(3)?,
        request: decode(row, 4)?,
        state: decode(row, 5)?,
        version: row.get(6)?,
        created_at_ms: row.get(7)?,
        updated_at_ms: row.get(8)?,
        steps: Vec::new(),
        backups: Vec::new(),
        preservation_plan: None,
    })
}

fn load(connection: &Connection, operation_id: &str) -> Result<Option<GitOperation>, Error> {
    let Some(mut operation) = connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM git_operations WHERE operation_id=?1"),
            [operation_id],
            from_row,
        )
        .optional()
        .map_err(unavailable)?
    else {
        return Ok(None);
    };
    operation.steps = connection
        .prepare(
            "SELECT step_json FROM git_operation_steps WHERE operation_id=?1 ORDER BY sequence",
        )
        .map_err(unavailable)?
        .query_map([operation_id], |row| decode(row, 0))
        .map_err(unavailable)?
        .collect::<rusqlite::Result<_>>()
        .map_err(unavailable)?;
    operation.backups = connection.prepare(
        "SELECT backup_json FROM git_operation_backups WHERE operation_id=?1 ORDER BY restore_order")
        .map_err(unavailable)?.query_map([operation_id], |row| decode(row, 0))
        .map_err(unavailable)?.collect::<rusqlite::Result<_>>().map_err(unavailable)?;
    operation.preservation_plan = connection
        .query_row(
            "SELECT plan_json FROM git_operation_preservation_plans WHERE operation_id=?1",
            [operation_id],
            |row| decode(row, 0),
        )
        .optional()
        .map_err(unavailable)?;
    Ok(Some(operation))
}

fn owner(connection: &Connection, resource_key: &str) -> Result<Option<String>, Error> {
    connection
        .query_row(
            "SELECT operation_id FROM git_operation_owners WHERE resource_key=?1",
            [resource_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(unavailable)
}

fn repository_owner(connection: &Connection, repo_id: &str) -> Result<Option<String>, Error> {
    connection
        .query_row(
            "SELECT operation_id FROM git_operations WHERE repo_id=?1 AND terminal=0",
            [repo_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(unavailable)
}

fn validate_step(old: Option<&OperationStep>, next: &OperationStep) -> Result<(), Error> {
    // The alternative restore destination is admitted by a dedicated claimed
    // action transaction. Generic journal writes cannot create or rewrite it.
    if next.kind == OperationStepKind::SourceRecovery {
        return if old == Some(next) {
            Ok(())
        } else {
            Err(Error::InvalidTransition)
        };
    }
    if next.input_fingerprint.is_empty() {
        return Err(Error::InvalidTransition);
    }
    if next.status != OperationStepStatus::Planned
        && next.before_fingerprint.as_deref().is_none_or(str::is_empty)
        || next.status == OperationStepStatus::Verified
            && next.after_fingerprint.as_deref().is_none_or(str::is_empty)
    {
        return Err(Error::InvalidTransition);
    }
    let Some(old) = old else {
        return if next.status == OperationStepStatus::Planned
            && next.source_objects.is_none()
            && (next.kind != OperationStepKind::Restore || next.after_fingerprint.is_none())
        {
            Ok(())
        } else {
            Err(Error::InvalidTransition)
        };
    };
    // Generic journal updates never reassign actors. The dedicated Planned
    // handoff transaction archives the exact previous checkpoint first; once
    // an intent exists its actor remains immutable even during reconciliation.
    if old.sequence != next.sequence
        || old.kind != next.kind
        || old.input_fingerprint != next.input_fingerprint
        || old.backup_id != next.backup_id
        || old.task_id != next.task_id
        || old.before_fingerprint.is_some() && old.before_fingerprint != next.before_fingerprint
    {
        return Err(Error::InvalidTransition);
    }
    if old.kind == OperationStepKind::Restore && old.after_fingerprint != next.after_fingerprint {
        let mut expected = old.clone();
        expected.after_fingerprint = next.after_fingerprint.clone();
        let valid_receipt = next.after_fingerprint.as_deref().is_some_and(|value| {
            value.strip_prefix("sha256:").is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            })
        });
        return if old.after_fingerprint.is_none()
            && old.status == OperationStepStatus::IntentRecorded
            && next.status == OperationStepStatus::IntentRecorded
            && old.task_id.as_deref().is_some_and(|id| !id.is_empty())
            && old.backup_id.as_deref().is_some_and(|id| !id.is_empty())
            && valid_receipt
            && expected == *next
        {
            Ok(())
        } else {
            Err(Error::InvalidTransition)
        };
    }
    if old.source_objects != next.source_objects {
        let mut expected = old.clone();
        expected.source_objects = next.source_objects.clone();
        return if old.source_objects.is_none()
            && next.source_objects.is_some()
            && old.kind == OperationStepKind::Clean
            && old.status == OperationStepStatus::IntentRecorded
            && expected == *next
        {
            Ok(())
        } else {
            Err(Error::InvalidTransition)
        };
    }
    use OperationStepStatus::*;
    if old == next
        || matches!(
            (old.status, next.status),
            (Planned, IntentRecorded) | (IntentRecorded, Verified | Unknown) | (Unknown, Verified)
        )
    {
        Ok(())
    } else {
        Err(Error::InvalidTransition)
    }
}

fn validate_backup(
    connection: &Connection,
    operation: &GitOperation,
    next: &OperationBackup,
) -> Result<(), Error> {
    let old = operation
        .backups
        .iter()
        .find(|backup| backup.shelf_id == next.shelf_id);
    if let Some(old) = old {
        let mut expected = old.clone();
        expected.disposition = next.disposition;
        if expected != *next
            || old.disposition != BackupDisposition::Retained && old.disposition != next.disposition
        {
            return Err(Error::InvalidBackup);
        }
    } else if next.disposition != BackupDisposition::Retained {
        return Err(Error::InvalidBackup);
    }
    // Verify the actual durable artifact, not just caller-supplied metadata.
    let shelf = connection
        .query_row(
            "SELECT repo_id, scope, head_oid, patch, paths_json FROM shelves WHERE shelf_id=?1",
            [&next.shelf_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(unavailable)?
        .ok_or(Error::InvalidBackup)?;
    let expected_scope = match next.scope {
        OperationBackupScope::Index => "Index",
        OperationBackupScope::WorkingTree => "WorkingTree",
    };
    if let Some(plan) = &operation.preservation_plan {
        let group = plan
            .groups
            .get(next.save_order as usize)
            .ok_or(Error::InvalidBackup)?;
        let mut expected_paths = group
            .selections
            .iter()
            .map(|s| s.path.as_str())
            .collect::<Vec<_>>();
        expected_paths.sort_unstable();
        let mut actual_paths: Vec<String> = serde_json::from_str(&shelf.4).map_err(unavailable)?;
        actual_paths.sort();
        if group.scope != next.scope
            || group.save_order != next.save_order
            || group.restore_order != next.restore_order
            || expected_paths != actual_paths.iter().map(String::as_str).collect::<Vec<_>>()
        {
            return Err(Error::InvalidBackup);
        }
    }
    if shelf.0 != operation.repo_id
        || shelf.1.as_deref() != Some(expected_scope)
        || shelf.2 != next.base_oid
        || format!("{:x}", Sha256::digest(&shelf.3)) != next.content_digest
        || operation.backups.iter().any(|backup| {
            backup.shelf_id != next.shelf_id
                && (backup.save_order == next.save_order
                    || backup.restore_order == next.restore_order)
        })
    {
        return Err(Error::InvalidBackup);
    }
    if next.disposition == BackupDisposition::KeptOnSource
        && operation.request.preservation != PreservationPolicy::KeepOnSourceBranch
    {
        return Err(Error::InvalidBackup);
    }
    Ok(())
}

impl OperationStorePort for RepositoryStore {
    fn take_over_planned_preservation(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, Error> {
        actions::take_over_planned(
            self,
            id,
            version,
            task,
            OperationActionKind::ResumePlannedPreservation,
        )
    }
    fn take_over_planned_checkout(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, Error> {
        actions::take_over_planned(
            self,
            id,
            version,
            task,
            OperationActionKind::ResumePlannedCheckout,
        )
    }

    fn take_over_planned_restoration(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, Error> {
        actions::take_over_planned(
            self,
            id,
            version,
            task,
            OperationActionKind::ResumePlannedRestoration,
        )
    }
    fn activate_restoration_resume(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, Error> {
        actions::activate_restoration_resume(self, id, version, task)
    }
    fn begin_source_recovery_after_rejection(
        &self,
        id: &str,
        version: i64,
        admitted_version: i64,
        task: &str,
        fingerprint: &str,
    ) -> Result<GitOperation, Error> {
        actions::begin_source_recovery(self, id, version, task, fingerprint, Some(admitted_version))
    }
    fn begin_source_recovery(
        &self,
        id: &str,
        version: i64,
        task: &str,
        fingerprint: &str,
    ) -> Result<GitOperation, Error> {
        actions::begin_source_recovery(self, id, version, task, fingerprint, None)
    }
    fn abandon_planned_checkout(
        &self,
        id: &str,
        version: i64,
        task: &str,
        fingerprint: &str,
    ) -> Result<GitOperation, Error> {
        actions::abandon_planned_checkout(self, id, version, task, fingerprint)
    }
    fn cancel_preparation(
        &self,
        id: &str,
        version: i64,
        task: &str,
    ) -> Result<GitOperation, Error> {
        actions::cancel_preparation(self, id, version, task)
    }
    fn preservation_actor_authorized(
        &self,
        id: &str,
        task: &str,
        sequence: u32,
    ) -> Result<bool, Error> {
        let connection = self.connection.lock().map_err(unavailable)?;
        actions::preservation_actor_authorized(&connection, id, task, sequence, false)
    }
    fn record_preservation_plan(
        &self,
        id: &str,
        version: i64,
        plan: OperationPreservationPlan,
    ) -> Result<GitOperation, Error> {
        plans::record(self, id, version, plan)
    }
    fn operation_request(
        &self,
        repo_id: &str,
        request_id: &str,
    ) -> Result<Option<GitOperation>, Error> {
        let connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection.unchecked_transaction().map_err(unavailable)?;
        let id: Option<String> = transaction
            .query_row(
                "SELECT operation_id FROM git_operations WHERE repo_id=?1 AND request_id=?2",
                params![repo_id, request_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(unavailable)?;
        let result = match id {
            Some(id) => load(&transaction, &id)?,
            None => None,
        };
        transaction.commit().map_err(unavailable)?;
        Ok(result)
    }
    fn create_operation(&self, input: NewOperation) -> Result<GitOperation, Error> {
        if [
            &input.operation_id,
            &input.repo_id,
            &input.resource_key,
            &input.request_id,
        ]
        .iter()
        .any(|value| value.trim().is_empty())
        {
            return Err(Error::InvalidTransition);
        }
        let mut connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        let existing: Option<(String, String)> = transaction.query_row(
            "SELECT operation_id, request_hash FROM git_operations WHERE repo_id=?1 AND request_id=?2",
            params![input.repo_id, input.request_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional().map_err(unavailable)?;
        let request_hash = input.request.fingerprint();
        if let Some((id, hash)) = existing {
            return if hash == request_hash {
                load(&transaction, &id)?.ok_or(Error::NotFound)
            } else {
                Err(Error::RequestConflict)
            };
        }
        if let Some(operation_id) = owner(&transaction, &input.resource_key)? {
            return Err(Error::ResourceOwned { operation_id });
        }
        if let Some(operation_id) = repository_owner(&transaction, &input.repo_id)? {
            return Err(Error::ResourceOwned { operation_id });
        }
        let active: i64 = transaction
            .query_row(
                "SELECT count(*) FROM git_operations WHERE terminal=0",
                [],
                |row| row.get(0),
            )
            .map_err(unavailable)?;
        if active >= MAX_ACTIVE_OPERATIONS {
            return Err(Error::TooManyActive);
        }
        let now = now_ms();
        transaction
            .execute(
                "INSERT INTO git_operations
            (operation_id,repo_id,resource_key,request_id,request_hash,request_json,state_json,
             version,terminal,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,1,0,?8,?8)",
                params![
                    input.operation_id,
                    input.repo_id,
                    input.resource_key,
                    input.request_id,
                    request_hash,
                    encode(&input.request)?,
                    encode(&OperationState::default())?,
                    now
                ],
            )
            .map_err(unavailable)?;
        transaction
            .execute(
                "INSERT INTO git_operation_owners(resource_key,operation_id) VALUES (?1,?2)",
                params![input.resource_key, input.operation_id],
            )
            .map_err(unavailable)?;
        let result = load(&transaction, &input.operation_id)?.ok_or(Error::NotFound)?;
        transaction.commit().map_err(unavailable)?;
        Ok(result)
    }

    fn operation(&self, operation_id: &str) -> Result<Option<GitOperation>, Error> {
        let connection = self.connection.lock().map_err(unavailable)?;
        // Keep the parent and child reads on one SQLite snapshot, including when
        // another store instance is writing the same database.
        let transaction = connection.unchecked_transaction().map_err(unavailable)?;
        let operation = load(&transaction, operation_id)?;
        transaction.commit().map_err(unavailable)?;
        Ok(operation)
    }

    fn active_operations(&self) -> Result<Vec<GitOperation>, Error> {
        let connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection.unchecked_transaction().map_err(unavailable)?;
        let ids = transaction
            .prepare(
                "SELECT operation_id FROM git_operations WHERE terminal=0
            ORDER BY created_at_ms,operation_id",
            )
            .map_err(unavailable)?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(unavailable)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(unavailable)?;
        let result = ids
            .iter()
            .map(|id| load(&transaction, id)?.ok_or(Error::NotFound))
            .collect::<Result<_, _>>()?;
        transaction.commit().map_err(unavailable)?;
        Ok(result)
    }

    fn operation_owner(&self, resource_key: &str) -> Result<Option<String>, Error> {
        let connection = self.connection.lock().map_err(unavailable)?;
        owner(&connection, resource_key)
    }

    fn repository_operation_owner(&self, repo_id: &str) -> Result<Option<String>, Error> {
        let connection = self.connection.lock().map_err(unavailable)?;
        repository_owner(&connection, repo_id)
    }

    fn update_operation(
        &self,
        operation_id: &str,
        expected_version: i64,
        update: OperationUpdate,
    ) -> Result<GitOperation, Error> {
        let mut connection = self.connection.lock().map_err(unavailable)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        let mut current = load(&transaction, operation_id)?.ok_or(Error::NotFound)?;
        if current.version != expected_version || expected_version == i64::MAX {
            return Err(Error::VersionConflict);
        }
        if current.state.status.is_terminal()
            || !update.state.is_valid()
            || owner(&transaction, &current.resource_key)?.as_deref() != Some(operation_id)
        {
            return Err(Error::InvalidTransition);
        }
        if let Some(step) = update.step {
            let old = current
                .steps
                .iter()
                .find(|old| old.sequence == step.sequence);
            validate_step(old, &step)?;
            if let Some(plan) = &current.preservation_plan {
                if matches!(
                    step.kind,
                    OperationStepKind::Save | OperationStepKind::Clean
                ) && step.task_id.as_deref() != Some(plan.task_id.as_str())
                {
                    let task = step.task_id.as_deref().ok_or(Error::InvalidTransition)?;
                    let running = old.is_none()
                        || old.is_some_and(|old| {
                            old.status == OperationStepStatus::Planned
                                && step.status == OperationStepStatus::IntentRecorded
                        });
                    if step.sequence as usize >= plan.groups.len() * 2
                        || (step.kind == OperationStepKind::Save) != step.sequence.is_multiple_of(2)
                        || !actions::preservation_actor_authorized(
                            &transaction,
                            operation_id,
                            task,
                            step.sequence,
                            running,
                        )?
                    {
                        return Err(Error::InvalidTransition);
                    }
                }
            }
            if let Some(roots) = &step.source_objects {
                if step.kind != OperationStepKind::Clean
                    || step.before_fingerprint.as_deref()
                        != Some(current.request.changes_fingerprint.as_str())
                    || current.request.source_head_oid.as_deref() != Some(roots.head_oid.as_str())
                    || !roots.matches_step(operation_id, &step)
                    || current
                        .steps
                        .iter()
                        .any(|s| s.kind == OperationStepKind::Clean && s.sequence < step.sequence)
                {
                    return Err(Error::InvalidTransition);
                }
            }
            if old.is_none() && step.sequence as usize != current.steps.len() {
                return Err(Error::InvalidTransition);
            }
            transaction.execute("INSERT INTO git_operation_steps(operation_id,sequence,step_json)
                VALUES (?1,?2,?3) ON CONFLICT(operation_id,sequence) DO UPDATE SET step_json=excluded.step_json",
                params![operation_id,step.sequence,encode(&step)?]).map_err(unavailable)?;
            current.steps.retain(|old| old.sequence != step.sequence);
            current.steps.push(step);
        }
        if let Some(backup) = update.backup {
            validate_backup(&transaction, &current, &backup)?;
            transaction
                .execute(
                    "INSERT INTO git_operation_backups
                (operation_id,shelf_id,save_order,restore_order,backup_json) VALUES (?1,?2,?3,?4,?5)
                ON CONFLICT(operation_id,shelf_id) DO UPDATE SET backup_json=excluded.backup_json",
                    params![
                        operation_id,
                        backup.shelf_id,
                        backup.save_order,
                        backup.restore_order,
                        encode(&backup)?
                    ],
                )
                .map_err(unavailable)?;
            current
                .backups
                .retain(|old| old.shelf_id != backup.shelf_id);
            current.backups.push(backup);
        }
        let terminal = update.state.status.is_terminal();
        if terminal
            && (current.steps.iter().any(|step| {
                matches!(
                    step.status,
                    OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
                )
            }) || current
                .backups
                .iter()
                .any(|backup| backup.disposition == BackupDisposition::Retained))
        {
            return Err(Error::InvalidTransition);
        }
        let changed = transaction
            .execute(
                "UPDATE git_operations SET state_json=?1,version=version+1,
            terminal=?2,updated_at_ms=?3 WHERE operation_id=?4 AND version=?5",
                params![
                    encode(&update.state)?,
                    terminal,
                    now_ms(),
                    operation_id,
                    expected_version
                ],
            )
            .map_err(unavailable)?;
        if changed != 1 {
            return Err(Error::VersionConflict);
        }
        if terminal {
            transaction
                .execute(
                    "DELETE FROM git_operation_owners WHERE operation_id=?1",
                    [operation_id],
                )
                .map_err(unavailable)?;
        }
        let result = load(&transaction, operation_id)?.ok_or(Error::NotFound)?;
        transaction.commit().map_err(unavailable)?;
        Ok(result)
    }
}

#[cfg(test)]
mod receipt_tests;
#[cfg(test)]
mod tests;
