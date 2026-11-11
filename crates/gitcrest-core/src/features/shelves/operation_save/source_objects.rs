use super::*;
use crate::ports::git::GitReadPort;

impl OperationSaveService {
    pub(super) async fn protect_source(
        &self,
        id: &str,
        path: &std::path::Path,
        context: &TaskContext,
    ) -> Result<(), TaskFailure> {
        let operation = self.load(id).await?;
        let source_fingerprint = operation.preservation_source_fingerprint();
        let identity = context
            .operation_identity()
            .ok_or_else(|| changed("Source protection requires an owner task."))?;
        if identity.operation_id != id
            || identity.repo_id != operation.repo_id
            || identity.resource_key != operation.resource_key
        {
            return Err(changed("Source protection identity changed."));
        }
        let first = operation
            .steps
            .iter()
            .find(|s| s.kind == OperationStepKind::Clean)
            .ok_or_else(|| {
                changed("A cleanup intent is required before protecting source objects.")
            })?;
        let (roots, create) = if let Some(roots) = &first.source_objects {
            if !roots.matches_step(id, first) {
                return Err(changed("Source protection evidence changed."));
            }
            (roots.clone(), false)
        } else {
            if first.status != OperationStepStatus::IntentRecorded
                || operation.steps.last() != Some(first)
                || first.task_id.as_deref() != Some(context.task_id())
                || source_fingerprint.is_none()
                || first.before_fingerprint.as_deref() != source_fingerprint
            {
                return Err(changed(
                    "Original source objects were not protected before cleanup.",
                ));
            }
            self.verify_location(&operation, path).await?;
            let before = evidence::read_snapshot(
                &self.commands,
                self.worktree.as_ref(),
                &operation.repo_id,
                path,
            )
            .await
            .map_err(|_| changed("Original source state cannot be verified."))?;
            if Some(before.fingerprint().as_str()) != source_fingerprint {
                return Err(changed("Source changed before object protection."));
            }
            let head_oid = self
                .commands
                .read_head_oid(path)
                .await
                .map_err(|_| changed("Original HEAD cannot be read."))?
                .ok_or_else(|| changed("Source protection requires an original commit."))?;
            let index_tree_oid = self.commands.read_index_tree(path).await?;
            let (head_reference, index_reference) = SourceObjectRoots::references(id, first);
            let roots = SourceObjectRoots {
                head_oid,
                index_tree_oid,
                head_reference,
                index_reference,
            };
            let mut step = first.clone();
            step.source_objects = Some(roots.clone());
            let store = self.operations.clone();
            let operation_id = id.to_owned();
            tokio::task::spawn_blocking(move || {
                store.update_operation(
                    &operation_id,
                    operation.version,
                    OperationUpdate {
                        state: operation.state,
                        step: Some(step),
                        backup: None,
                    },
                )
            })
            .await
            .map_err(|_| unknown("Source protection intent could not be confirmed."))?
            .map_err(|_| unknown("Source protection intent could not be recorded."))?;
            (roots, true)
        };
        self.commands
            .protect_source_objects(path, &roots, context.clone(), create)
            .await?;
        let current = self.load(id).await?;
        self.verify_location(&current, path).await?;
        // Each group still validates its own cleanup evidence; first cleanup
        // additionally rechecks the untouched complete original source.
        if create {
            let after = evidence::read_snapshot(
                &self.commands,
                self.worktree.as_ref(),
                &current.repo_id,
                path,
            )
            .await
            .map_err(|_| changed("Protected source state could not be rechecked."))?;
            if Some(after.fingerprint().as_str()) != current.preservation_source_fingerprint() {
                return Err(changed("Source changed while protecting its Git objects."));
            }
        }
        Ok(())
    }
}
