use super::{
    checkout::OperationCheckoutService,
    pull_fetch::{authorize, changed, check_cancel, preparing, unknown},
};
use crate::{
    domain::{
        git_result::GitFailureCode, operation::*, operation_action::OperationActionKind,
        workflow::MergeKind,
    },
    execution::{TaskContext, TaskFailure},
    features::shelves::evidence,
    ports::git::GitReadPort,
};
use std::path::Path;

impl OperationCheckoutService {
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
        if merge != (relation.kind == MergeKind::MergeCommit)
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
            input_fingerprint: if merge {
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
                if merge {
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
            if merge {
                return self
                    .confirm_live_pull_merge(
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

    async fn confirm_live_pull_merge(
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
            .ok_or_else(|| unknown("The Pull merge HEAD cannot be read."))?;
        let after = evidence::read_carry_snapshot(
            commands,
            self.saves.worktree.as_ref(),
            &operation.repo_id,
            path,
        )
        .await
        .map_err(|_| unknown("The Pull merge worktree cannot be verified."))?;
        let branch = operation.request.source_branch.as_deref();
        let actual = after.fingerprint();
        if !after.matches_source(Some(&head), branch)
            || actual != before.fingerprint_at(Some(&head), branch)
            || !commands
                .has_pull_merge_parents(path, &head, source, target)
                .await?
            || commands
                .read_pull_fetch_ref(path, &operation.pull_fetch_ref())
                .await?
                .as_deref()
                != Some(target)
        {
            return Err(unknown("The Pull merge result cannot be verified."));
        }
        let step = operation
            .pull_integration_step()
            .cloned()
            .ok_or_else(|| unknown("The Pull merge intent is missing."))?;
        self.finish_pull_integration(
            operation,
            path,
            context,
            step,
            head.clone(),
            format!("{head}:{actual}"),
        )
        .await
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
        self.record(operation, state, Some(step)).await
    }
}
