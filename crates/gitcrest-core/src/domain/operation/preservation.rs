use super::*;

impl GitOperation {
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
