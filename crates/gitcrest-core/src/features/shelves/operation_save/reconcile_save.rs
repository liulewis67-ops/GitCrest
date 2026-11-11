use super::*;
use crate::domain::{diff::DiffScope, operation_action::OperationActionKind};
#[cfg(test)]
mod tests;

impl OperationSaveService {
    pub(crate) async fn review_abandoned_save(
        &self,
        operation: &GitOperation,
        context: &TaskContext,
    ) -> Result<(), TaskFailure> {
        self.review_pending_save(operation, context).await?;
        Ok(())
    }

    /// Observe a persisted save artifact. Reads never run save/apply/cleanup or
    /// repair source refs, and cannot transfer the original writer identity.
    pub(crate) async fn reconcile_save(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let operation = self.load(id).await?;
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("An owner task is required to verify a saved copy."))?;
        if identity.operation_id != id
            || identity.version != operation.version
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
            || !OperationActionKind::ReconcileSave.allowed(&operation)
        {
            return Err(changed(
                "This operation is not waiting for saved copy verification.",
            ));
        }
        let reviewed = self.review_pending_save(&operation, context).await?;
        let group = &operation
            .preservation_plan
            .as_ref()
            .expect("required by action")
            .groups[operation.steps.len() / 2];
        let mut journal = ShelfSaveJournal::for_group(
            self.operations.clone(),
            operation.clone(),
            &reviewed.before,
            &reviewed.shelf,
            group.save_order,
            group.restore_order,
        )?;
        journal.reconcile_save(&reviewed.shelf).await?;
        Ok(journal.operation)
    }

    pub(super) async fn review_pending_save(
        &self,
        operation: &GitOperation,
        context: &TaskContext,
    ) -> Result<PendingSave, TaskFailure> {
        let id = operation.operation_id.as_str();
        let plan = operation
            .preservation_plan
            .as_ref()
            .expect("required by action");
        let completed = operation.steps.len() / 2;
        let group = &plan.groups[completed];
        let save = operation.steps.last().expect("required by action");
        let actor = save
            .task_id
            .as_deref()
            .filter(|task| !task.is_empty())
            .ok_or_else(|| changed("The original save task is missing."))?;
        if actor != plan.task_id {
            let store = self.operations.clone();
            let id = id.to_owned();
            let actor = actor.to_owned();
            let sequence = save.sequence;
            if !tokio::task::spawn_blocking(move || {
                store.preservation_actor_authorized(&id, &actor, sequence)
            })
            .await
            .map_err(|_| unknown("The original save authorization could not be read."))?
            .map_err(|_| unknown("The original save authorization could not be read."))?
            {
                return Err(changed(
                    "The original save task has no persisted authorization.",
                ));
            }
        }
        let expected = if completed == 0 {
            plan.source_fingerprint.clone()
        } else {
            let mut prefix = operation.clone();
            prefix.steps.pop();
            prefix
                .backups
                .retain(|b| (b.save_order as usize) < completed);
            let expected = proof::prefix(&prefix, completed)?;
            proof::verify_artifacts(
                self.shelves.clone(),
                self.operations.clone(),
                &prefix,
                completed,
            )
            .await?;
            expected
        };
        let stable_id = operation.preservation_shelf_id(group.save_order);
        if save.kind != OperationStepKind::Save
            || plan.source_fingerprint != operation.request.changes_fingerprint
            || plan.task_id.trim().is_empty()
            || group.save_order as usize != completed
            || group.restore_order as usize != plan.groups.len() - completed - 1
            || save.sequence as usize != completed * 2
            || save.before_fingerprint.as_deref() != Some(expected.as_str())
            || save.backup_id.as_deref() != Some(stable_id.as_str())
            || (save.status != OperationStepStatus::Verified && save.after_fingerprint.is_some())
            || save.source_objects.is_some()
        {
            return Err(changed(
                "The saved copy intent does not match its original plan.",
            ));
        }
        let target = self
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The saved copy repository is unavailable."))?;
        self.verify_location(operation, &target.repository_path)
            .await?;
        if completed > 0 {
            let roots = operation
                .steps
                .iter()
                .find_map(|s| s.source_objects.as_ref())
                .ok_or_else(|| changed("Original source protection is missing."))?;
            self.commands
                .protect_source_objects(&target.repository_path, roots, context.clone(), false)
                .await?;
        }
        let before = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
        )
        .await
        .map_err(|_| changed("The saved copy source cannot be verified."))?;
        if before.fingerprint() != expected
            || !before.matches_source(
                operation.request.source_head_oid.as_deref(),
                operation.request.source_branch.as_deref(),
            )
            || !before.matches_changes(plan.groups[completed..].iter().flat_map(|group| {
                group.selections.iter().map(move |selection| {
                    (
                        selection.path.as_str(),
                        scope(group.scope),
                        selection.revision.as_str(),
                    )
                })
            }))
        {
            return Err(changed(
                "The local changes no longer match the source of this saved copy.",
            ));
        }
        let status = self
            .commands
            .read_status(operation.repo_id.clone(), &target.repository_path, &[])
            .await
            .map_err(|_| changed("The saved copy scopes could not be read."))?;
        let selections = group
            .selections
            .iter()
            .map(|selection| ShelfSelection {
                path: selection.path.clone(),
                scope: scope(group.scope),
                revision: selection.revision.clone(),
                selections: Vec::new(),
            })
            .collect::<Vec<_>>();
        let prepared = preparation::prepare_items(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
            &status.files,
            &selections,
        )
        .await
        .map_err(|_| changed("The saved copy source scopes changed or cannot be verified."))?;
        let planned = save.status == OperationStepStatus::Planned;
        let shelf = if planned {
            if read_optional_shelf(self.shelves.clone(), &operation.repo_id, &stable_id)
                .await?
                .is_some()
            {
                return Err(changed(
                    "A Planned save already has an artifact; no copy was replaced.",
                ));
            }
            ShelfRecord {
                snapshot: ShelfSnapshot {
                    shelf_id: stable_id.clone(),
                    repo_id: operation.repo_id.clone(),
                    name: group.name.trim().into(),
                    description: group.description.clone(),
                    paths: prepared.paths.clone(),
                    scope: Some(prepared.scope),
                    head_oid: operation.request.source_head_oid.clone(),
                    created_at_ms: 0,
                },
                patch: prepared.patch.clone(),
            }
        } else {
            read_shelf(self.shelves.clone(), &operation.repo_id, &stable_id).await?
        };
        if shelf.snapshot.shelf_id != stable_id
            || shelf.snapshot.repo_id != operation.repo_id
            || shelf.snapshot.head_oid != operation.request.source_head_oid
            || shelf.snapshot.scope != Some(prepared.scope)
            || shelf.snapshot.paths != prepared.paths
            || shelf.snapshot.name != group.name.trim()
            || shelf.snapshot.description != group.description
            || shelf.patch != prepared.patch
            || save.input_fingerprint != super::super::journal::save_input(&shelf, &expected)?
        {
            return Err(changed(
                "The actual saved copy does not match its recorded intent and source.",
            ));
        }
        if save.status == OperationStepStatus::Verified {
            let backup = operation
                .backups
                .iter()
                .find(|b| b.save_order == group.save_order)
                .ok_or_else(|| changed("The verified save backup is missing."))?;
            if backup.scope != group.scope
                || backup.restore_order != group.restore_order
                || backup.base_oid != operation.request.source_head_oid
                || backup.shelf_id != stable_id
                || backup.disposition != BackupDisposition::Retained
                || backup.content_digest != format!("{:x}", Sha256::digest(&shelf.patch))
                || save.after_fingerprint.as_deref() != Some(backup.content_digest.as_str())
            {
                return Err(changed(
                    "The verified save backup no longer matches its artifact.",
                ));
            }
        }
        let repeated = evidence::read_snapshot(
            &self.commands,
            self.worktree.as_ref(),
            &operation.repo_id,
            &target.repository_path,
        )
        .await
        .map_err(|_| changed("The saved copy source could not be rechecked."))?;
        let repeated_shelf =
            read_optional_shelf(self.shelves.clone(), &operation.repo_id, &stable_id).await?;
        if repeated != before
            || if planned {
                repeated_shelf.is_some()
            } else {
                repeated_shelf.as_ref() != Some(&shelf)
            }
        {
            return Err(changed(
                "The saved copy or its source changed during verification.",
            ));
        }
        self.verify_location(operation, &target.repository_path)
            .await?;
        if context.cancellation_requested() {
            return Err(TaskFailure::Cancelled);
        }
        Ok(PendingSave {
            before,
            shelf,
            prepared,
            path: target.repository_path,
        })
    }
}

pub(super) struct PendingSave {
    pub before: evidence::PreservationSnapshot,
    pub shelf: ShelfRecord,
    pub prepared: preparation::PreparedShelf,
    pub path: std::path::PathBuf,
}

async fn read_shelf(
    store: Arc<dyn ShelfStorePort>,
    repo: &str,
    shelf: &str,
) -> Result<ShelfRecord, TaskFailure> {
    read_optional_shelf(store, repo, shelf)
        .await?
        .ok_or_else(|| changed("The saved copy is missing; no save or cleanup was retried."))
}

async fn read_optional_shelf(
    store: Arc<dyn ShelfStorePort>,
    repo: &str,
    shelf: &str,
) -> Result<Option<ShelfRecord>, TaskFailure> {
    let repo = repo.to_owned();
    let shelf = shelf.to_owned();
    tokio::task::spawn_blocking(move || store.read_shelf_record(&repo, &shelf))
        .await
        .map_err(|_| unknown("The saved copy could not be read."))?
        .map_err(|_| unknown("The saved copy could not be read."))
}

fn scope(scope: OperationBackupScope) -> DiffScope {
    match scope {
        OperationBackupScope::WorkingTree => DiffScope::WorkingTree,
        OperationBackupScope::Index => DiffScope::Index,
    }
}
