use super::*;

impl GitOperation {
    pub fn pending_save_intent(&self) -> Option<&OperationStep> {
        let group = self.backups.len();
        let plan = self.preservation_plan.as_ref()?;
        let selection = plan.groups.get(group)?;
        let sequence = group.checked_mul(2)?;
        let save = self.steps.get(sequence)?;
        let before = if group == 0 {
            self.request.changes_fingerprint.as_str()
        } else {
            self.steps.get(sequence - 1)?.after_fingerprint.as_deref()?
        };
        (selection.save_order as usize == group
            && plan.source_fingerprint == self.request.changes_fingerprint
            && save.sequence as usize == sequence
            && save.kind == OperationStepKind::Save
            && matches!(
                save.status,
                OperationStepStatus::IntentRecorded | OperationStepStatus::Unknown
            )
            && save.task_id.as_deref().is_some_and(|task| !task.is_empty())
            && !save.input_fingerprint.is_empty()
            && save.before_fingerprint.as_deref() == Some(before)
            && save.after_fingerprint.is_none()
            && save.source_objects.is_none()
            && save.backup_id.as_deref()
                == Some(self.preservation_shelf_id(selection.save_order).as_str()))
        .then_some(save)
    }

    /// Identify a verified Save whose Clean has not crossed the intent boundary.
    pub fn uncleaned_save_group(&self) -> Option<usize> {
        let group = self.backups.len().checked_sub(1)?;
        let sequence = group * 2;
        let save = self.steps.get(sequence)?;
        if save.kind != OperationStepKind::Save || save.status != OperationStepStatus::Verified {
            return None;
        }
        let before = self.source_after_cleaned_prefix(group)?;
        if !self.matches_uncleaned_save(group, &before) {
            return None;
        }
        match &self.steps[sequence + 1..] {
            [] => Some(group),
            [clean]
                if clean.sequence as usize == sequence + 1
                    && clean.kind == OperationStepKind::Clean
                    && clean.status == OperationStepStatus::Planned
                    && clean.before_fingerprint == save.before_fingerprint
                    && clean.backup_id == save.backup_id
                    && clean.task_id.as_deref().is_some_and(|id| !id.is_empty())
                    && !clean.input_fingerprint.is_empty()
                    && clean.after_fingerprint.is_none()
                    && clean.failure_code.is_none()
                    && clean.source_objects.is_none() =>
            {
                Some(group)
            }
            _ => None,
        }
    }

    pub fn matches_uncleaned_save(&self, group: usize, before: &str) -> bool {
        let Some(plan) = self.preservation_plan.as_ref() else {
            return false;
        };
        let Some(selection) = plan.groups.get(group) else {
            return false;
        };
        let Some(save) = self.steps.get(group * 2) else {
            return false;
        };
        self.backups
            .iter()
            .find(|b| b.save_order as usize == group)
            .is_some_and(|backup| {
                selection.save_order as usize == group
                    && selection.restore_order as usize == plan.groups.len() - group - 1
                    && !selection.selections.is_empty()
                    && save.sequence as usize == group * 2
                    && save.kind == OperationStepKind::Save
                    && save.status == OperationStepStatus::Verified
                    && save.task_id.as_deref().is_some_and(|task| !task.is_empty())
                    && !save.input_fingerprint.is_empty()
                    && save.failure_code.is_none()
                    && save.source_objects.is_none()
                    && save.before_fingerprint.as_deref() == Some(before)
                    && save.after_fingerprint.as_deref() == Some(backup.content_digest.as_str())
                    && save.backup_id.as_deref() == Some(backup.shelf_id.as_str())
                    && backup.shelf_id == self.preservation_shelf_id(selection.save_order)
                    && backup.scope == selection.scope
                    && backup.restore_order == selection.restore_order
                    && backup.base_oid == self.request.source_head_oid
            })
    }

    /// The fingerprint after the last completed Clean, before any pending Save.
    pub fn source_after_cleaned_prefix(&self, groups: usize) -> Option<String> {
        let mut prefix = self.clone();
        prefix.steps.truncate(groups * 2);
        prefix.backups.retain(|b| (b.save_order as usize) < groups);
        for backup in &mut prefix.backups {
            backup.disposition = BackupDisposition::Retained;
        }
        if groups == 0 {
            let plan = self.preservation_plan.as_ref()?;
            return (plan.source_fingerprint == self.request.changes_fingerprint)
                .then(|| plan.source_fingerprint.clone());
        }
        prefix.verified_saved_prefix(groups).map(str::to_owned)
    }

    pub fn preservation_shelf_id(&self, save_order: u32) -> String {
        let bytes = serde_json::to_vec(&(&self.operation_id, save_order))
            .expect("backup identity serializes");
        format!("operation-shelf-{:x}", Sha256::digest(bytes))
    }

    /// Validate the immutable Save/Clean prefix without accessing Git.
    /// Artifact bytes and live actor grants are verified separately by services.
    pub fn verified_saved_prefix(&self, groups: usize) -> Option<&str> {
        let plan = self.preservation_plan.as_ref()?;
        if groups == 0
            || groups > plan.groups.len()
            || plan.source_fingerprint != self.request.changes_fingerprint
            || self.steps.len() != groups * 2
            || self.backups.len() != groups
        {
            return None;
        }
        let mut expected = self.request.changes_fingerprint.as_str();
        let source_clean = self
            .steps
            .iter()
            .find(|s| s.kind == OperationStepKind::Clean)?;
        let roots = source_clean.source_objects.as_ref()?;
        if !roots.matches_step(&self.operation_id, source_clean)
            || self.request.source_head_oid.as_deref() != Some(roots.head_oid.as_str())
        {
            return None;
        }
        for (index, group) in plan.groups.iter().take(groups).enumerate() {
            let save = &self.steps[index * 2];
            let clean = &self.steps[index * 2 + 1];
            let backup = self
                .backups
                .iter()
                .find(|b| b.save_order == group.save_order)?;
            if group.save_order != index as u32
                || group.restore_order != (plan.groups.len() - index - 1) as u32
                || group.selections.is_empty()
                || save.sequence as usize != index * 2
                || clean.sequence as usize != index * 2 + 1
                || save.kind != OperationStepKind::Save
                || clean.kind != OperationStepKind::Clean
                || save.status != OperationStepStatus::Verified
                || clean.status != OperationStepStatus::Verified
                || save.task_id.as_deref().is_none_or(str::is_empty)
                || clean.task_id.as_deref().is_none_or(str::is_empty)
                || save.backup_id.as_deref() != Some(backup.shelf_id.as_str())
                || clean.backup_id != save.backup_id
                || save.before_fingerprint.as_deref() != Some(expected)
                || clean.before_fingerprint != save.before_fingerprint
                || save.after_fingerprint.as_deref() != Some(backup.content_digest.as_str())
                || clean.after_fingerprint.as_deref() != Some(clean.input_fingerprint.as_str())
                || backup.scope != group.scope
                || backup.restore_order != group.restore_order
                || backup.base_oid != self.request.source_head_oid
                || backup.disposition != BackupDisposition::Retained
            {
                return None;
            }
            expected = clean.input_fingerprint.as_str();
        }
        Some(expected)
    }
}
