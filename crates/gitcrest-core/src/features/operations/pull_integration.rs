use super::{
    checkout::OperationCheckoutService,
    pull_fetch::{authorize, changed, check_cancel, preparing, unknown},
};
use crate::{
    domain::{
        git_result::GitFailureCode,
        operation::*,
        operation_action::OperationActionKind,
        workflow::{MergeKind, WorkflowOperation, WorkflowRecoveryAction},
    },
    execution::{TaskContext, TaskFailure},
    features::shelves::evidence,
    ports::{git::GitReadPort, operation_actions::OperationActionStorePort},
};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};

fn merge_resolution_fingerprint(index: &str, snapshot: &evidence::PreservationSnapshot) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{index}:{}", snapshot.worktree_fingerprint()))
    )
}

impl OperationCheckoutService {
    pub(super) async fn abort_pull_merge(
        &self,
        id: &str,
        context: &TaskContext,
        store: Arc<dyn OperationActionStorePort>,
        kind: OperationActionKind,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        authorize(&operation, context, kind)?;
        let target = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| unknown("The Pull repository is unavailable."))?;
        let path = &target.repository_path;
        if !operation.backups.is_empty() {
            super::checkout::saved::verify_artifacts(&self.saves, &operation).await?;
        }
        if matches!(
            kind,
            OperationActionKind::ReconcileAbortedPullMerge
                | OperationActionKind::ReconcileAbortedPullRebase
        ) {
            return self
                .confirm_aborted_divergent_pull(operation, path, context, store)
                .await;
        }
        self.verify_pull_merge_abort_source(&operation, path)
            .await?;
        check_cancel(context)?;
        let checkpoint_store = store.clone();
        let checkpoint_id = id.to_owned();
        let task = context.task_id().to_owned();
        let version = operation.version;
        operation = tokio::task::spawn_blocking(move || {
            checkpoint_store.begin_pull_merge_abort(&checkpoint_id, version, &task)
        })
        .await
        .map_err(|_| unknown("The Pull merge abort checkpoint could not be confirmed."))?
        .map_err(|_| unknown("The Pull merge abort checkpoint could not be saved."))?;
        let result = async {
            self.verify_pull_merge_abort_source(&operation, path)
                .await?;
            check_cancel(context)?;
            self.saves
                .commands
                .execute_workflow_recovery(
                    path,
                    if kind == OperationActionKind::AbortPullRebase {
                        WorkflowOperation::Rebase
                    } else {
                        WorkflowOperation::Merge
                    },
                    WorkflowRecoveryAction::Abort,
                    context.clone(),
                )
                .await?;
            self.confirm_aborted_divergent_pull(operation.clone(), path, context, store)
                .await
        }
        .await;
        if result.is_err() {
            self.record(
                &mut operation,
                OperationState {
                    phase: OperationPhase::Executing,
                    status: OperationStatus::RecoveryRequired,
                    wait_reason: Some(OperationWaitReason::OutcomeUnknown),
                    failure_code: Some(GitFailureCode::OutcomeUnknown),
                    result_head_oid: None,
                },
                None,
            )
            .await?;
        }
        result
    }

    async fn verify_pull_merge_abort_source(
        &self,
        operation: &GitOperation,
        path: &Path,
    ) -> Result<(), TaskFailure> {
        self.verify_pull_conflict(operation, path, false).await?;
        let source = operation
            .request
            .source_head_oid
            .as_deref()
            .ok_or_else(|| unknown("The Pull merge source is missing."))?;
        if operation.pull_rebase_source_ref().is_none()
            && !self.saves.commands.matches_orig_head(path, source).await?
        {
            return Err(changed(
                "ORIG_HEAD does not match the original Pull source.",
            ));
        }
        Ok(())
    }

    async fn confirm_aborted_divergent_pull(
        &self,
        operation: GitOperation,
        path: &Path,
        context: &TaskContext,
        store: Arc<dyn OperationActionStorePort>,
    ) -> Result<GitOperation, TaskFailure> {
        self.location(&operation, path).await?;
        let commands = &self.saves.commands;
        let step = operation
            .pending_divergent_pull()
            .ok_or_else(|| unknown("The Pull merge intent is missing."))?;
        let snapshot = if operation.backups.is_empty() {
            evidence::read_carry_snapshot(
                commands,
                self.saves.worktree.as_ref(),
                &operation.repo_id,
                path,
            )
            .await
        } else {
            evidence::read_snapshot(
                commands,
                self.saves.worktree.as_ref(),
                &operation.repo_id,
                path,
            )
            .await
        }
        .map_err(|_| unknown("The aborted Pull merge source could not be verified."))?;
        let observed = snapshot.fingerprint();
        if !snapshot.matches_source(
            operation.request.source_head_oid.as_deref(),
            operation.request.source_branch.as_deref(),
        ) || step.before_fingerprint.as_deref() != Some(observed.as_str())
        {
            return Err(unknown(
                "The aborted Pull merge source does not match the original workspace.",
            ));
        }
        self.location(&operation, path).await?;
        check_cancel(context)?;
        let task = context.task_id().to_owned();
        let operation = tokio::task::spawn_blocking(move || {
            store.confirm_pull_merge_abort(
                &operation.operation_id,
                operation.version,
                &task,
                &observed,
            )
        })
        .await
        .map_err(|_| unknown("The Pull merge abort receipt could not be confirmed."))?
        .map_err(|_| unknown("The Pull merge abort receipt could not be saved."))?;
        self.release_pull_source_ref(&operation, path, context)
            .await;
        Ok(operation)
    }
    pub(super) async fn continue_pull_merge(
        &self,
        id: &str,
        context: &TaskContext,
        store: Arc<dyn OperationActionStorePort>,
        kind: OperationActionKind,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        authorize(&operation, context, kind)?;
        let target = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| unknown("The Pull repository is unavailable."))?;
        let path = &target.repository_path;
        let rebase = matches!(
            kind,
            OperationActionKind::ContinuePullRebase
                | OperationActionKind::ReconcileContinuedPullRebase
        );
        if matches!(
            kind,
            OperationActionKind::ReconcileContinuedPullMerge
                | OperationActionKind::ReconcileContinuedPullRebase
        ) {
            let id = id.to_owned();
            let expected = tokio::task::spawn_blocking(move || store.pull_merge_resolution(&id))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
                .ok_or_else(|| unknown("The Pull merge resolution checkpoint is missing."))?;
            self.confirm_continued_pull(&mut operation, path, context, &expected, rebase)
                .await?;
            return Ok(operation);
        }
        if !operation.backups.is_empty() {
            super::checkout::saved::verify_artifacts(&self.saves, &operation).await?;
        }
        let expected = self.read_pull_resolution(&operation, path, rebase).await?;
        check_cancel(context)?;
        let checkpoint = expected.clone();
        let id = id.to_owned();
        let task = context.task_id().to_owned();
        let version = operation.version;
        operation = tokio::task::spawn_blocking(move || {
            store.begin_pull_merge_continuation(&id, version, &task, &checkpoint)
        })
        .await
        .map_err(|_| unknown("The Pull merge continuation checkpoint could not be confirmed."))?
        .map_err(|_| unknown("The Pull merge continuation checkpoint could not be saved."))?;
        let result = async {
            if self.read_pull_resolution(&operation, path, rebase).await? != expected {
                return Err(changed("The staged Pull merge resolution changed."));
            }
            check_cancel(context)?;
            self.saves
                .commands
                .execute_workflow_recovery(
                    path,
                    if rebase {
                        WorkflowOperation::Rebase
                    } else {
                        WorkflowOperation::Merge
                    },
                    WorkflowRecoveryAction::Continue,
                    context.clone(),
                )
                .await?;
            self.confirm_continued_pull(&mut operation, path, context, &expected, rebase)
                .await
        }
        .await;
        if let Err(error) = result {
            if rebase
                && matches!(&error, TaskFailure::Diagnosed { failure, .. } if failure.code == GitFailureCode::HistoryConflict)
                && self
                    .verify_pull_conflict(&operation, path, true)
                    .await
                    .is_ok()
                && self.record_pull_conflict(&mut operation).await.is_ok()
            {
                return Err(error);
            }
            self.record(
                &mut operation,
                OperationState {
                    phase: OperationPhase::Executing,
                    status: OperationStatus::RecoveryRequired,
                    wait_reason: Some(OperationWaitReason::OutcomeUnknown),
                    failure_code: Some(GitFailureCode::OutcomeUnknown),
                    result_head_oid: None,
                },
                None,
            )
            .await?;
            return Err(error);
        }
        Ok(operation)
    }

    async fn read_pull_resolution(
        &self,
        operation: &GitOperation,
        path: &Path,
        rebase: bool,
    ) -> Result<String, TaskFailure> {
        if rebase {
            self.read_pull_rebase_resolution(operation, path).await
        } else {
            self.read_pull_merge_resolution(operation, path).await
        }
    }

    async fn confirm_continued_pull(
        &self,
        operation: &mut GitOperation,
        path: &Path,
        context: &TaskContext,
        expected: &str,
        rebase: bool,
    ) -> Result<(), TaskFailure> {
        if rebase {
            self.confirm_continued_pull_rebase(operation, path, context)
                .await
        } else {
            self.confirm_continued_pull_merge(operation, path, context, expected)
                .await
        }
    }

    async fn read_pull_rebase_resolution(
        &self,
        operation: &GitOperation,
        path: &Path,
    ) -> Result<String, TaskFailure> {
        self.location(operation, path).await?;
        let commands = &self.saves.commands;
        let target = operation
            .verified_pull_target()
            .ok_or_else(|| changed("The fetched Pull target is missing."))?;
        let reference = operation
            .pull_rebase_source_ref()
            .ok_or_else(|| changed("The Pull rebase source reference is missing."))?;
        let source = operation
            .request
            .source_head_oid
            .as_deref()
            .ok_or_else(|| changed("The Pull rebase source is missing."))?;
        let branch = operation
            .request
            .source_branch
            .as_deref()
            .ok_or_else(|| changed("The Pull rebase branch is missing."))?;
        let first = commands.pull_merge_index_fingerprint(path).await?;
        let snapshot = evidence::read_rebase_resolution_snapshot(
            commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| changed("Resolve and stage the Pull rebase conflicts before continuing."))?;
        if snapshot.has_worktree_changes()
            || !commands
                .matches_rebase_state(path, branch, source, target)
                .await
                .unwrap_or(false)
            || commands
                .read_pull_fetch_ref(path, &reference)
                .await?
                .as_deref()
                != Some(source)
            || commands
                .read_pull_fetch_ref(path, &operation.pull_fetch_ref())
                .await?
                .as_deref()
                != Some(target)
            || commands.pull_merge_index_fingerprint(path).await? != first
        {
            return Err(changed(
                "The Pull rebase resolution does not match the pending operation.",
            ));
        }
        self.location(operation, path).await?;
        Ok(merge_resolution_fingerprint(&first, &snapshot))
    }

    async fn confirm_continued_pull_rebase(
        &self,
        operation: &mut GitOperation,
        path: &Path,
        context: &TaskContext,
    ) -> Result<(), TaskFailure> {
        self.location(operation, path).await?;
        let commands = &self.saves.commands;
        let target = operation
            .verified_pull_target()
            .ok_or_else(|| unknown("The fetched Pull target is missing."))?;
        let source = operation
            .request
            .source_head_oid
            .as_deref()
            .ok_or_else(|| unknown("The Pull rebase source is missing."))?;
        let head = commands
            .read_head_oid(path)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| unknown("The continued Pull rebase HEAD cannot be read."))?;
        let snapshot = evidence::read_carry_snapshot(
            commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| unknown("The continued Pull rebase worktree cannot be verified."))?;
        if !snapshot.matches_source(Some(&head), operation.request.source_branch.as_deref())
            || !snapshot.is_clean()
            || !self
                .verify_divergent_pull_history(operation, path, &head, source, target)
                .await?
            || commands
                .read_pull_fetch_ref(path, &operation.pull_fetch_ref())
                .await?
                .as_deref()
                != Some(target)
        {
            return Err(unknown(
                "The continued Pull rebase result cannot be verified.",
            ));
        }
        let step = operation
            .pending_divergent_pull()
            .cloned()
            .ok_or_else(|| unknown("The unresolved Pull rebase intent is missing."))?;
        let receipt = format!("{head}:{}", snapshot.fingerprint());
        self.finish_pull_integration(operation, path, context, step, head, receipt)
            .await
    }

    async fn read_pull_merge_resolution(
        &self,
        operation: &GitOperation,
        path: &Path,
    ) -> Result<String, TaskFailure> {
        self.location(operation, path).await?;
        let commands = &self.saves.commands;
        let target = operation
            .verified_pull_target()
            .ok_or_else(|| changed("The fetched Pull target is missing."))?;
        let first = commands.pull_merge_index_fingerprint(path).await?;
        let snapshot = evidence::read_merge_resolution_snapshot(
            commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| changed("Resolve and stage the Pull merge conflicts before continuing."))?;
        if !snapshot.matches_source(
            operation.request.source_head_oid.as_deref(),
            operation.request.source_branch.as_deref(),
        ) || (!operation.backups.is_empty() && snapshot.has_worktree_changes())
            || !commands
                .matches_merge_head(path, target)
                .await
                .unwrap_or(false)
            || commands
                .read_pull_fetch_ref(path, &operation.pull_fetch_ref())
                .await?
                .as_deref()
                != Some(target)
            || commands.pull_merge_index_fingerprint(path).await? != first
        {
            return Err(changed(
                "The Pull merge resolution does not match the pending operation.",
            ));
        }
        self.location(operation, path).await?;
        Ok(merge_resolution_fingerprint(&first, &snapshot))
    }

    async fn confirm_continued_pull_merge(
        &self,
        operation: &mut GitOperation,
        path: &Path,
        context: &TaskContext,
        expected: &str,
    ) -> Result<(), TaskFailure> {
        self.location(operation, path).await?;
        let commands = &self.saves.commands;
        let target = operation
            .verified_pull_target()
            .ok_or_else(|| unknown("The fetched Pull target is missing."))?;
        let source = operation
            .request
            .source_head_oid
            .as_deref()
            .ok_or_else(|| unknown("The Pull merge source is missing."))?;
        let head = commands
            .read_head_oid(path)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| unknown("The continued Pull merge HEAD cannot be read."))?;
        let first = commands.pull_merge_index_fingerprint(path).await?;
        let snapshot = evidence::read_carry_snapshot(
            commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| unknown("The continued Pull merge worktree cannot be verified."))?;
        if !snapshot.matches_source(Some(&head), operation.request.source_branch.as_deref())
            || snapshot.has_staged_changes()
            || merge_resolution_fingerprint(&first, &snapshot) != expected
            || !commands
                .has_pull_merge_parents(path, &head, source, target)
                .await?
            || commands
                .read_pull_fetch_ref(path, &operation.pull_fetch_ref())
                .await?
                .as_deref()
                != Some(target)
            || commands.pull_merge_index_fingerprint(path).await? != first
        {
            return Err(unknown(
                "The continued Pull merge result does not match the recorded resolution.",
            ));
        }
        let step = operation
            .pending_divergent_pull()
            .cloned()
            .ok_or_else(|| unknown("The unresolved Pull merge intent is missing."))?;
        let receipt = format!("{head}:{}", snapshot.fingerprint());
        self.finish_pull_integration(operation, path, context, step, head, receipt)
            .await
    }
    pub(super) async fn integrate_pull(
        &self,
        id: &str,
        context: &TaskContext,
        kind: OperationActionKind,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        authorize(&operation, context, kind)?;
        let location = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| changed("The Pull repository is unavailable."))?;
        let path = &location.repository_path;
        let target = operation
            .verified_pull_target()
            .ok_or_else(|| changed("The fetched Pull target is missing."))?
            .to_owned();
        let source = operation
            .request
            .source_head_oid
            .clone()
            .ok_or_else(|| changed("The Pull source is missing."))?;
        let protected = operation.preservation_plan.is_some();
        let before = if protected {
            self.verify_pull_preservation_target(&operation).await?;
            super::checkout::saved::verify_artifacts(&self.saves, &operation).await?;
            let roots = operation
                .steps
                .iter()
                .find_map(|step| step.source_objects.as_ref())
                .ok_or_else(|| changed("The Pull source protection is missing."))?;
            self.saves
                .commands
                .protect_source_objects(path, roots, context.clone(), false)
                .await?;
            self.review_cleaned_pull_source(&operation, path).await?
        } else {
            let preview = self.review_fetched_pull(&operation).await?;
            if preview.preservation.is_some() {
                return Err(changed("The reviewed Pull requires preservation."));
            }
            self.verify_pull_source(&operation.repo_id, &operation.request, path)
                .await?
        };
        let relation = self
            .saves
            .commands
            .read_merge_relation(path, &source, &target)
            .await
            .map_err(|_| changed("The fetched Pull ancestry cannot be verified."))?;
        let merge = kind == OperationActionKind::MergePull;
        let rebase = kind == OperationActionKind::RebasePull;
        let divergent = merge || rebase;
        if divergent != (relation.kind == MergeKind::MergeCommit)
            || relation.kind == MergeKind::UpToDate
                && source != target
                && matches!(
                    operation.request.command,
                    OperationCommand::PullRebase { .. }
                )
        {
            return Err(changed(
                "The reviewed Pull ancestry does not match the integration action.",
            ));
        }
        let up_to_date = relation.kind == MergeKind::UpToDate;
        let result_head = if up_to_date { &source } else { &target };
        let expected = before.fingerprint_at(
            Some(result_head),
            operation.request.source_branch.as_deref(),
        );
        let mut step = OperationStep {
            sequence: operation
                .steps
                .len()
                .try_into()
                .map_err(|_| changed("The Pull journal is full."))?,
            kind: OperationStepKind::Execute,
            status: OperationStepStatus::Planned,
            input_fingerprint: if rebase {
                operation.pull_rebase_input()
            } else if merge {
                operation.pull_merge_input()
            } else {
                operation.pull_fast_forward_input(&expected, up_to_date)
            }
            .ok_or_else(|| changed("The Pull review does not authorize integration."))?,
            before_fingerprint: Some(before.fingerprint()),
            after_fingerprint: None,
            task_id: Some(context.task_id().into()),
            backup_id: None,
            failure_code: None,
            source_objects: None,
            source_recovery_outcome: None,
        };
        check_cancel(context)?;
        let ready = OperationState {
            phase: operation.state.phase,
            ..preparing()
        };
        self.record(&mut operation, ready, Some(step.clone()))
            .await?;
        // The source fingerprint and pinned commit determine the already
        // reviewed protection decision. Recheck the lease before invocation.
        self.location(&operation, path).await?;
        if protected {
            self.verify_pull_preservation_target(&operation).await?;
            self.review_cleaned_pull_source(&operation, path).await?;
        } else {
            self.review_pull_source(&operation.repo_id, &operation.request, path, &target)
                .await?;
            if self
                .saves
                .commands
                .read_pull_fetch_ref(path, &operation.pull_fetch_ref())
                .await?
                .as_deref()
                != Some(target.as_str())
            {
                return Err(changed("The Pull target changed before fast-forward."));
            }
        }
        check_cancel(context)?;
        step.status = OperationStepStatus::IntentRecorded;
        let executing = OperationState {
            phase: OperationPhase::Executing,
            ..preparing()
        };
        self.record(&mut operation, executing.clone(), Some(step.clone()))
            .await?;
        let result = async {
            check_cancel(context)?;
            if !up_to_date {
                self.location(&operation, path).await?;
                if self
                    .saves
                    .commands
                    .read_head_oid(path)
                    .await
                    .ok()
                    .flatten()
                    .as_deref()
                    != Some(source.as_str())
                    || self
                        .saves
                        .commands
                        .read_current_branch(path)
                        .await
                        .ok()
                        .flatten()
                        != operation.request.source_branch
                {
                    return Err(changed("The Pull source moved before Git could start."));
                }
                if rebase {
                    let source_ref = operation
                        .pull_rebase_source_ref()
                        .ok_or_else(|| changed("The Pull rebase source reference is missing."))?;
                    let branch = operation
                        .request
                        .source_branch
                        .as_deref()
                        .ok_or_else(|| changed("The Pull rebase branch is missing."))?;
                    self.saves
                        .commands
                        .rebase_fetched_pull(
                            path,
                            &source,
                            branch,
                            &target,
                            &source_ref,
                            context.clone(),
                        )
                        .await?;
                } else if merge {
                    self.saves
                        .commands
                        .merge_fetched_pull(path, &target, context.clone())
                        .await?;
                } else {
                    self.saves
                        .commands
                        .fast_forward_pull(path, &target, context.clone())
                        .await?;
                }
            }
            if divergent {
                return self
                    .confirm_live_divergent_pull(
                        &mut operation,
                        path,
                        context,
                        &before,
                        &source,
                        &target,
                    )
                    .await;
            }
            self.confirm_pull_fast_forward(&mut operation, path, context)
                .await
        }
        .await;
        if let Err(error) = result {
            if divergent
                && matches!(&error, TaskFailure::Diagnosed { failure, .. } if failure.code == GitFailureCode::HistoryConflict)
                && self
                    .verify_pull_conflict(&operation, path, true)
                    .await
                    .is_ok()
                && self.record_pull_conflict(&mut operation).await.is_ok()
            {
                return Err(error);
            }
            if let Some(received) = operation.pending_divergent_pull().filter(|_| divergent) {
                step = received.clone();
            }
            step.status = OperationStepStatus::Unknown;
            step.failure_code = Some(GitFailureCode::OutcomeUnknown);
            self.record(
                &mut operation,
                OperationState {
                    status: OperationStatus::RecoveryRequired,
                    wait_reason: Some(OperationWaitReason::OutcomeUnknown),
                    failure_code: Some(GitFailureCode::OutcomeUnknown),
                    ..executing
                },
                Some(step),
            )
            .await?;
            return Err(error);
        }
        Ok(operation)
    }

    pub(super) async fn reconcile_pull_conflict(
        &self,
        id: &str,
        context: &TaskContext,
        kind: OperationActionKind,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        authorize(&operation, context, kind)?;
        let location = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| unknown("The Pull repository is unavailable."))?;
        self.verify_pull_conflict(&operation, &location.repository_path, true)
            .await?;
        check_cancel(context)?;
        self.record_pull_conflict(&mut operation).await?;
        Ok(operation)
    }

    async fn verify_pull_conflict(
        &self,
        operation: &GitOperation,
        path: &Path,
        require_conflicts: bool,
    ) -> Result<(), TaskFailure> {
        let target = operation
            .verified_pull_target()
            .ok_or_else(|| unknown("The fetched Pull target is missing."))?;
        let commands = &self.saves.commands;
        let observe = || async {
            self.location(operation, path).await?;
            let state = commands
                .read_worktree_state(path)
                .await
                .map_err(|_| unknown("The Pull conflict state cannot be read."))?;
            let source = operation.request.source_head_oid.as_deref();
            let branch = operation.request.source_branch.as_deref();
            let live_state = if let Some(reference) = operation.pull_rebase_source_ref() {
                match (source, branch) {
                    (Some(source), Some(branch)) => {
                        commands
                            .matches_rebase_state(path, branch, source, target)
                            .await
                            .unwrap_or(false)
                            && commands
                                .read_pull_fetch_ref(path, &reference)
                                .await?
                                .as_deref()
                                == Some(source)
                    }
                    _ => false,
                }
            } else {
                commands.read_head_oid(path).await.ok().flatten().as_deref() == source
                    && commands
                        .read_current_branch(path)
                        .await
                        .ok()
                        .flatten()
                        .as_deref()
                        == branch
                    && commands
                        .matches_merge_head(path, target)
                        .await
                        .unwrap_or(false)
            };
            let expected = if operation.pull_rebase_source_ref().is_some() {
                WorkflowOperation::Rebase
            } else {
                WorkflowOperation::Merge
            };
            if state.operation != Some(expected)
                || (require_conflicts
                    && state.conflicted_paths.is_empty()
                    && state.omitted_conflicted_path_count == 0)
                || !live_state
                || commands
                    .read_pull_fetch_ref(path, &operation.pull_fetch_ref())
                    .await?
                    .as_deref()
                    != Some(target)
            {
                return Err(unknown(
                    "The current conflict does not match the Pull integration intent.",
                ));
            }
            Ok(state)
        };
        if observe().await? != observe().await? {
            return Err(unknown("The Pull conflict changed during verification."));
        }
        self.location(operation, path).await?;
        Ok(())
    }

    async fn record_pull_conflict(&self, operation: &mut GitOperation) -> Result<(), TaskFailure> {
        let mut step = operation
            .pending_divergent_pull()
            .cloned()
            .ok_or_else(|| unknown("The unresolved Pull integration intent is missing."))?;
        step.status = OperationStepStatus::Unknown;
        self.record(
            operation,
            OperationState {
                phase: OperationPhase::Executing,
                status: OperationStatus::WaitingForInput,
                wait_reason: Some(OperationWaitReason::HistoryConflict),
                failure_code: Some(GitFailureCode::HistoryConflict),
                result_head_oid: None,
            },
            Some(step),
        )
        .await
    }

    async fn confirm_live_divergent_pull(
        &self,
        operation: &mut GitOperation,
        path: &Path,
        context: &TaskContext,
        before: &evidence::PreservationSnapshot,
        source: &str,
        target: &str,
    ) -> Result<(), TaskFailure> {
        self.location(operation, path).await?;
        let commands = &self.saves.commands;
        let head = commands
            .read_head_oid(path)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| unknown("The Pull integration HEAD cannot be read."))?;
        let after = evidence::read_carry_snapshot(
            commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| unknown("The Pull integration worktree cannot be verified."))?;
        let branch = operation.request.source_branch.as_deref();
        let actual = after.fingerprint();
        if !after.matches_source(Some(&head), branch)
            || actual != before.fingerprint_at(Some(&head), branch)
            || !self
                .verify_divergent_pull_history(operation, path, &head, source, target)
                .await?
            || commands
                .read_pull_fetch_ref(path, &operation.pull_fetch_ref())
                .await?
                .as_deref()
                != Some(target)
        {
            return Err(unknown("The Pull integration result cannot be verified."));
        }
        let mut step = operation
            .pending_divergent_pull()
            .cloned()
            .ok_or_else(|| unknown("The Pull integration intent is missing."))?;
        let receipt = format!("{head}:{actual}");
        self.location(operation, path).await?;
        step.after_fingerprint = Some(receipt.clone());
        let executing = operation.state.clone();
        self.record(operation, executing, Some(step.clone()))
            .await?;
        self.finish_pull_integration(operation, path, context, step, head, receipt)
            .await
    }

    async fn verify_divergent_pull_history(
        &self,
        operation: &GitOperation,
        path: &Path,
        head: &str,
        source: &str,
        target: &str,
    ) -> Result<bool, TaskFailure> {
        let commands = &self.saves.commands;
        if let Some(reference) = operation.pull_rebase_source_ref() {
            let relation = commands
                .read_merge_relation(path, head, target)
                .await
                .map_err(|_| unknown("The Pull rebase ancestry cannot be verified."))?;
            return Ok(relation.kind == MergeKind::UpToDate
                && commands.matches_orig_head(path, source).await?
                && commands
                    .read_pull_fetch_ref(path, &reference)
                    .await?
                    .as_deref()
                    == Some(source));
        }
        commands
            .has_pull_merge_parents(path, head, source, target)
            .await
    }

    pub(super) async fn reconcile_completed_divergent_pull(
        &self,
        id: &str,
        context: &TaskContext,
        kind: OperationActionKind,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        authorize(&operation, context, kind)?;
        let target = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| unknown("The Pull repository is unavailable."))?;
        let path = &target.repository_path;
        self.location(&operation, path).await?;
        if !operation.backups.is_empty() {
            super::checkout::saved::verify_artifacts(&self.saves, &operation).await?;
        }
        let step = operation
            .pending_divergent_pull()
            .cloned()
            .ok_or_else(|| unknown("The completed Pull integration receipt is missing."))?;
        let head = operation
            .pull_integration_head(&step)
            .ok_or_else(|| unknown("The recorded Pull integration HEAD is missing."))?;
        let source = operation
            .request
            .source_head_oid
            .as_deref()
            .ok_or_else(|| unknown("The original Pull integration HEAD is missing."))?;
        let target = operation
            .verified_pull_target()
            .ok_or_else(|| unknown("The fetched Pull target is missing."))?;
        let commands = &self.saves.commands;
        let snapshot = evidence::read_carry_snapshot(
            commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| unknown("The Pull integration result cannot be read."))?;
        if !snapshot.matches_source(Some(head), operation.request.source_branch.as_deref())
            || operation.pull_integration_fingerprint(&step)
                != Some(snapshot.fingerprint().as_str())
            || !self
                .verify_divergent_pull_history(&operation, path, head, source, target)
                .await?
            || commands
                .read_pull_fetch_ref(path, &operation.pull_fetch_ref())
                .await?
                .as_deref()
                != Some(target)
        {
            return Err(unknown(
                "The Pull integration result differs from the recorded receipt.",
            ));
        }
        let head = head.to_owned();
        let receipt = step
            .after_fingerprint
            .clone()
            .ok_or_else(|| unknown("The completed Pull integration receipt is missing."))?;
        self.finish_pull_integration(&mut operation, path, context, step, head, receipt)
            .await?;
        Ok(operation)
    }

    async fn review_cleaned_pull_source(
        &self,
        operation: &GitOperation,
        path: &Path,
    ) -> Result<evidence::PreservationSnapshot, TaskFailure> {
        let expected = operation
            .source_after_cleaned_prefix(operation.backups.len())
            .ok_or_else(|| changed("The Pull preservation proof is incomplete."))?;
        let source = evidence::read_snapshot(
            &self.saves.commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| changed("The cleaned Pull source cannot be verified."))?;
        if !source.is_clean()
            || source.fingerprint() != expected
            || !source.matches_source(
                operation.request.source_head_oid.as_deref(),
                operation.request.source_branch.as_deref(),
            )
        {
            return Err(changed("The cleaned Pull source changed."));
        }
        self.location(operation, path).await?;
        Ok(source)
    }

    pub(super) async fn reconcile_pull_fast_forward(
        &self,
        id: &str,
        context: &TaskContext,
    ) -> Result<GitOperation, TaskFailure> {
        let mut operation = self.load(id).await?;
        authorize(
            &operation,
            context,
            OperationActionKind::ReconcilePullFastForward,
        )?;
        let location = self
            .saves
            .targets
            .task_target(&operation.repo_id)
            .await
            .map_err(|_| unknown("The Pull repository is unavailable."))?;
        self.confirm_pull_fast_forward(&mut operation, &location.repository_path, context)
            .await?;
        Ok(operation)
    }

    async fn confirm_pull_fast_forward(
        &self,
        operation: &mut GitOperation,
        path: &Path,
        context: &TaskContext,
    ) -> Result<(), TaskFailure> {
        let target = operation
            .verified_pull_target()
            .ok_or_else(|| unknown("The fetched Pull target cannot be verified."))?
            .to_owned();
        let step = operation
            .pull_integration_step()
            .filter(|step| {
                matches!(
                    step.status,
                    OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
                )
            })
            .cloned()
            .ok_or_else(|| unknown("There is no unresolved Pull fast-forward intent."))?;
        self.location(operation, path).await?;
        let after = evidence::read_carry_snapshot(
            &self.saves.commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| unknown("The Pull result cannot be read."))?;
        let actual = after.fingerprint();
        let result_head = operation
            .pull_integration_head(&step)
            .ok_or_else(|| unknown("The expected Pull result is missing."))?;
        let up_to_date = step.input_fingerprint.starts_with("pull-up-to-date:");
        if !after.matches_source(
            Some(result_head),
            operation.request.source_branch.as_deref(),
        ) || operation
            .pull_fast_forward_input(&actual, up_to_date)
            .as_ref()
            != Some(&step.input_fingerprint)
            || self
                .saves
                .commands
                .read_pull_fetch_ref(path, &operation.pull_fetch_ref())
                .await?
                .as_deref()
                != Some(target.as_str())
        {
            return Err(unknown(
                "The Pull result or carried changes cannot be verified.",
            ));
        }
        if up_to_date
            && self
                .saves
                .commands
                .read_merge_relation(path, result_head, &target)
                .await
                .map_err(|_| unknown("The fetched Pull ancestry cannot be verified."))?
                .kind
                != MergeKind::UpToDate
        {
            return Err(unknown(
                "The fetched Pull target is not contained in the source.",
            ));
        }
        self.finish_pull_integration(
            operation,
            path,
            context,
            step.clone(),
            result_head.to_owned(),
            actual,
        )
        .await
    }

    async fn finish_pull_integration(
        &self,
        operation: &mut GitOperation,
        path: &Path,
        context: &TaskContext,
        mut step: OperationStep,
        result_head: String,
        actual: String,
    ) -> Result<(), TaskFailure> {
        self.location(operation, path).await?;
        check_cancel(context)?;
        step.status = OperationStepStatus::Verified;
        step.after_fingerprint = Some(actual);
        step.failure_code = None;
        let state = OperationState {
            phase: if operation.backups.is_empty() {
                OperationPhase::Finished
            } else {
                OperationPhase::Restoring
            },
            status: if operation.backups.is_empty() {
                OperationStatus::Succeeded
            } else {
                OperationStatus::Running
            },
            wait_reason: None,
            failure_code: None,
            result_head_oid: Some(result_head),
        };
        self.record(operation, state, Some(step)).await?;
        self.release_pull_source_ref(operation, path, context).await;
        Ok(())
    }

    /// Best effort: the operation is already terminal, so a leftover reference
    /// only costs a stale ref and never affects the recorded result.
    pub(in crate::features::operations) async fn release_pull_source_ref(
        &self,
        operation: &GitOperation,
        path: &Path,
        context: &TaskContext,
    ) {
        if !operation.state.status.is_terminal() {
            return;
        }
        let (Some(reference), Some(source)) = (
            operation.pull_rebase_source_ref(),
            operation.request.source_head_oid.as_deref(),
        ) else {
            return;
        };
        let _ = self
            .saves
            .commands
            .release_pull_source_ref(path, &reference, source, context.clone())
            .await;
    }
}
