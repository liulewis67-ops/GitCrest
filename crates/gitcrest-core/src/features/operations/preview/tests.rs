use super::*;
use crate::{
    git::{command::GitCommandService, refs::GitBranchAdapter},
    storage::diff::DiffWorktreeAdapter,
};
use std::process::Command;

fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
pub(crate) fn repository() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    git(path, &["init", "-q", "-b", "main"]);
    git(path, &["config", "user.name", "Preview Test"]);
    git(path, &["config", "user.email", "preview@example.invalid"]);
    git(path, &["config", "core.autocrlf", "false"]);
    for file in ["a", "b"] {
        std::fs::write(path.join(file), "base\n").unwrap();
    }
    git(path, &["add", "."]);
    git(path, &["commit", "-qm", "base"]);
    git(path, &["switch", "-qc", "other"]);
    std::fs::write(path.join("a"), "other\n").unwrap();
    git(path, &["commit", "-qam", "target"]);
    git(path, &["switch", "-q", "main"]);
    dir
}
async fn preview(
    path: &Path,
    target: &CheckoutTargetRequest,
    preservation: PreservationPolicy,
) -> Result<CheckoutPreview, PreviewError> {
    read_checkout(
        &GitCommandService::default(),
        &DiffWorktreeAdapter,
        &GitBranchAdapter,
        "repo",
        path,
        CheckoutPreviewInput {
            target,
            preservation,
            shelf_name: "backup",
            shelf_description: "",
        },
    )
    .await
}

#[tokio::test]
async fn operation_checkout_preview_carries_non_overlapping_binary_without_attempting_shelf_preparation(
) {
    let dir = repository();
    let path = dir.path();
    std::fs::write(path.join("b"), [0, 1, 2]).unwrap();
    let request = CheckoutTargetRequest::LocalBranch("other".into());
    let result = preview(path, &request, PreservationPolicy::Restore)
        .await
        .unwrap();
    assert_eq!(result.reason, PreservationReason::SafeToCarry);
    assert!(result.preservation.is_none() && result.overlapping_paths.is_empty());
    assert_eq!(result.source_branch.as_deref(), Some("main"));
    assert_eq!(
        result.target,
        ResolvedCheckoutTarget::LocalBranch {
            name: "other".into(),
            oid: git(path, &["rev-parse", "refs/heads/other"])
        }
    );
    assert!(matches!(
        preview(path, &request, PreservationPolicy::KeepOnSourceBranch).await,
        Err(PreviewError::Preservation(PlanningError::Blocked(_)))
    ));
    assert_eq!(std::fs::read(path.join("b")).unwrap(), [0, 1, 2]);
    assert_eq!(git(path, &["branch", "--show-current"]), "main");
}

#[tokio::test]
async fn operation_checkout_preview_plans_all_scopes_only_for_overlap_or_keep_on_source() {
    let dir = repository();
    let path = dir.path();
    std::fs::write(path.join("a"), "staged\n").unwrap();
    git(path, &["add", "a"]);
    std::fs::write(path.join("a"), "working\n").unwrap();
    std::fs::write(path.join("new"), "new\n").unwrap();
    let result = preview(
        path,
        &CheckoutTargetRequest::LocalBranch("other".into()),
        PreservationPolicy::Restore,
    )
    .await
    .unwrap();
    assert_eq!(result.reason, PreservationReason::OverwriteRisk);
    assert_eq!(result.overlapping_paths, vec!["a"]);
    let plan = result.preservation.unwrap();
    assert_eq!(plan.groups.len(), 2);
    assert_eq!(plan.groups[0].selections.len(), 2);
    assert_eq!(plan.groups[0].restore_order, 1);
    assert_eq!(plan.groups[1].restore_order, 0);
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "working\n"
    );
    assert_eq!(git(path, &["show", ":a"]), "staged");
    assert!(path.join("new").exists());
}

#[tokio::test]
async fn operation_checkout_preview_resolves_branch_and_detached_targets_without_tag_ambiguity() {
    let dir = repository();
    let path = dir.path();
    git(path, &["tag", "other", "main"]);
    let target_oid = git(path, &["rev-parse", "refs/heads/other"]);
    let result = preview(
        path,
        &CheckoutTargetRequest::LocalBranch("other".into()),
        PreservationPolicy::Restore,
    )
    .await
    .unwrap();
    assert_eq!(result.target.oid(), target_oid);
    assert!(result.preservation.is_none());
    let result = preview(
        path,
        &CheckoutTargetRequest::Commit(target_oid[..8].into()),
        PreservationPolicy::Restore,
    )
    .await
    .unwrap();
    assert_eq!(
        result.target,
        ResolvedCheckoutTarget::DetachedCommit { oid: target_oid }
    );
    assert!(matches!(
        preview(
            path,
            &CheckoutTargetRequest::Commit("other".into()),
            PreservationPolicy::Restore
        )
        .await,
        Err(PreviewError::InvalidTarget)
    ));
    assert!(matches!(
        preview(
            path,
            &CheckoutTargetRequest::LocalBranch("main".into()),
            PreservationPolicy::Restore
        )
        .await,
        Err(PreviewError::AlreadyCurrent)
    ));
    assert_eq!(git(path, &["branch", "--show-current"]), "main");
}

#[tokio::test]
async fn operation_checkout_preview_rejects_target_in_another_worktree_and_active_merge() {
    let dir = repository();
    let path = dir.path();
    let worktree = tempfile::tempdir().unwrap();
    let child = worktree.path().join("checkout");
    git(
        path,
        &["worktree", "add", "-q", child.to_str().unwrap(), "other"],
    );
    assert!(matches!(
        preview(
            path,
            &CheckoutTargetRequest::LocalBranch("other".into()),
            PreservationPolicy::Restore
        )
        .await,
        Err(PreviewError::TargetInUse)
    ));
    git(path, &["worktree", "remove", child.to_str().unwrap()]);
    std::fs::write(path.join("a"), "main\n").unwrap();
    git(path, &["commit", "-qam", "main diverges"]);
    let merge = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["merge", "other"])
        .output()
        .unwrap();
    assert!(!merge.status.success());
    assert!(matches!(
        preview(
            path,
            &CheckoutTargetRequest::LocalBranch("other".into()),
            PreservationPolicy::Restore
        )
        .await,
        Err(PreviewError::ActiveWorkflow)
    ));
}
