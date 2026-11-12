use super::*;

fn intent() -> OperationStep {
    OperationStep {
        sequence: 0,
        kind: OperationStepKind::Restore,
        status: OperationStepStatus::IntentRecorded,
        input_fingerprint: "input".into(),
        before_fingerprint: Some("before".into()),
        after_fingerprint: None,
        task_id: Some("original-task".into()),
        backup_id: Some("backup".into()),
        failure_code: None,
        source_recovery_outcome: None,
        source_objects: None,
    }
}

#[test]
fn restore_receipt_attaches_only_to_its_existing_intent_and_remains_immutable() {
    let original = intent();
    let mut observed = original.clone();
    observed.after_fingerprint = Some(format!("sha256:{}", "a".repeat(64)));
    assert_eq!(validate_step(Some(&original), &observed), Ok(()));
    let mut verified = observed.clone();
    verified.status = OperationStepStatus::Verified;
    assert_eq!(validate_step(Some(&observed), &verified), Ok(()));
    assert_eq!(
        validate_step(Some(&original), &verified),
        Err(Error::InvalidTransition)
    );
    let mut unknown = observed.clone();
    unknown.status = OperationStepStatus::Unknown;
    assert_eq!(validate_step(Some(&observed), &unknown), Ok(()));
    assert_eq!(validate_step(Some(&unknown), &verified), Ok(()));
    for old in [&observed, &unknown, &verified] {
        let mut removed = old.clone();
        removed.after_fingerprint = None;
        assert_eq!(
            validate_step(Some(old), &removed),
            Err(Error::InvalidTransition)
        );
        let mut replaced = old.clone();
        replaced.after_fingerprint = Some(format!("sha256:{}", "b".repeat(64)));
        assert_eq!(
            validate_step(Some(old), &replaced),
            Err(Error::InvalidTransition)
        );
    }
    let mut variants = Vec::new();
    let mut changed = observed.clone();
    changed.task_id = Some("other-task".into());
    variants.push(changed);
    let mut changed = observed.clone();
    changed.backup_id = Some("other-backup".into());
    variants.push(changed);
    let mut changed = observed.clone();
    changed.failure_code = Some(crate::domain::git_result::GitFailureCode::OutcomeUnknown);
    variants.push(changed);
    let mut changed = observed.clone();
    changed.status = OperationStepStatus::Unknown;
    variants.push(changed);
    for fingerprint in [
        "",
        "sha256:short",
        "arbitrary",
        &format!("sha256:{}", "A".repeat(64)),
    ] {
        let mut changed = observed.clone();
        changed.after_fingerprint = Some(fingerprint.into());
        variants.push(changed);
    }
    for changed in variants {
        assert_eq!(
            validate_step(Some(&original), &changed),
            Err(Error::InvalidTransition)
        );
    }
    for status in [OperationStepStatus::Planned, OperationStepStatus::Unknown] {
        let mut old = original.clone();
        old.status = status;
        let mut next = observed.clone();
        next.status = status;
        assert_eq!(
            validate_step(Some(&old), &next),
            Err(Error::InvalidTransition)
        );
    }
    let mut planned = observed.clone();
    planned.status = OperationStepStatus::Planned;
    assert_eq!(validate_step(None, &planned), Err(Error::InvalidTransition));
    for missing_task in [false, true] {
        let mut old = original.clone();
        if missing_task {
            old.task_id = None;
        } else {
            old.backup_id = None;
        }
        let mut next = old.clone();
        next.after_fingerprint = observed.after_fingerprint.clone();
        assert_eq!(
            validate_step(Some(&old), &next),
            Err(Error::InvalidTransition)
        );
    }
}

#[test]
fn pull_merge_receipt_cannot_be_invented_while_marking_an_intent_unknown() {
    let original = OperationStep {
        kind: OperationStepKind::Execute,
        input_fingerprint: "pull-merge:input".into(),
        backup_id: None,
        ..intent()
    };
    let mut received = original.clone();
    received.after_fingerprint = Some(format!("{}:sha256:{}", "a".repeat(40), "b".repeat(64)));
    let mut unknown = received.clone();
    unknown.status = OperationStepStatus::Unknown;
    assert_eq!(
        validate_step(Some(&original), &unknown),
        Err(Error::InvalidTransition)
    );
    assert_eq!(validate_step(Some(&original), &received), Ok(()));
    assert_eq!(validate_step(Some(&received), &unknown), Ok(()));
    let mut confirmed = unknown.clone();
    confirmed.status = OperationStepStatus::Verified;
    assert_eq!(validate_step(Some(&unknown), &confirmed), Ok(()));
    confirmed.after_fingerprint = Some(format!("{}:sha256:{}", "c".repeat(40), "b".repeat(64)));
    assert_eq!(
        validate_step(Some(&unknown), &confirmed),
        Err(Error::InvalidTransition)
    );
}

#[test]
fn restore_receipt_legacy_unknown_json_remains_readable_without_fabricated_evidence() {
    let mut legacy = intent();
    legacy.status = OperationStepStatus::Unknown;
    let mut json = serde_json::to_value(&legacy).unwrap();
    json.as_object_mut().unwrap().remove("afterFingerprint");
    let restored: OperationStep = serde_json::from_value(json).unwrap();
    assert_eq!(restored, legacy);
    let mut fabricated = restored.clone();
    fabricated.after_fingerprint = Some(format!("sha256:{}", "a".repeat(64)));
    fabricated.status = OperationStepStatus::Verified;
    assert_eq!(
        validate_step(Some(&restored), &fabricated),
        Err(Error::InvalidTransition)
    );
}
