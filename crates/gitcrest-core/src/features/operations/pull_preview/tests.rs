use super::*;
use crate::{
    domain::{branch::BranchReference, error::GitAdapterError},
    git::{command::GitCommandService, refs::GitBranchAdapter, remote::GitRemoteAdapter},
    ports::branches::BranchGitFuture,
    storage::diff::DiffWorktreeAdapter,
};
use std::{
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};

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
fn repository() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    git(path, &["init", "-q", "-b", "main"]);
    git(path, &["config", "user.name", "Pull Preview"]);
    git(
        path,
        &["config", "user.email", "pull-preview@example.invalid"],
    );
    git(path, &["config", "core.autocrlf", "false"]);
    for file in ["a", "b"] {
        std::fs::write(path.join(file), "base\n").unwrap();
    }
    git(path, &["add", "."]);
    git(path, &["commit", "-qm", "base"]);
    git(path, &["switch", "-qc", "remote-target"]);
    std::fs::write(path.join("a"), "remote\n").unwrap();
    git(path, &["commit", "-qam", "remote"]);
    git(path, &["switch", "-q", "main"]);
    // No server exists at this URL: successful previews prove no fetch is attempted.
    git(
        path,
        &[
            "remote",
            "add",
            "origin",
            path.join("missing.git").to_str().unwrap(),
        ],
    );
    git(
        path,
        &[
            "update-ref",
            "refs/remotes/origin/main",
            "refs/heads/remote-target",
        ],
    );
    git(path, &["branch", "--set-upstream-to=origin/main", "main"]);
    dir
}
async fn preview(path: &Path, strategy: RemotePullStrategy) -> Result<PullPreview, PreviewError> {
    read_pull(
        &GitCommandService::default(),
        &DiffWorktreeAdapter,
        &GitBranchAdapter,
        &GitRemoteAdapter,
        "repo",
        path,
        PullPreviewInput {
            strategy,
            preservation: PreservationPolicy::Restore,
            shelf_name: "backup",
            shelf_description: "",
        },
    )
    .await
}

#[tokio::test]
async fn operation_pull_preview_merge_carries_binary_but_rebase_requires_supported_preservation() {
    let dir = repository();
    let path = dir.path();
    std::fs::write(path.join("b"), [0, 1, 2]).unwrap();
    let result = preview(path, RemotePullStrategy::Merge).await.unwrap();
    assert!(result.reason.is_none() && result.preservation.is_none());
    assert!(!result.preflight.merge_requires_preservation);
    assert_eq!(result.strategy, RemotePullStrategy::Merge);
    assert_eq!(result.command.local_oid, git(path, &["rev-parse", "HEAD"]));
    assert_eq!(
        result.command.tracking_oid,
        git(path, &["rev-parse", "refs/remotes/origin/main"])
    );
    assert!(matches!(
        preview(path, RemotePullStrategy::Rebase).await,
        Err(PreviewError::Preservation(
            planning::PlanningError::Blocked(_)
        ))
    ));
    assert_eq!(std::fs::read(path.join("b")).unwrap(), [0, 1, 2]);
    assert_eq!(git(path, &["branch", "--show-current"]), "main");
}

#[tokio::test]
async fn operation_pull_preview_staged_non_overlap_requires_all_scopes_for_merge_and_rebase() {
    let dir = repository();
    let path = dir.path();
    std::fs::write(path.join("b"), "staged\n").unwrap();
    git(path, &["add", "b"]);
    std::fs::write(path.join("b"), "working\n").unwrap();
    for (strategy, reason) in [
        (
            RemotePullStrategy::Merge,
            PullPreservationReason::StagedChanges,
        ),
        (
            RemotePullStrategy::Rebase,
            PullPreservationReason::DirtyRebase,
        ),
    ] {
        let result = preview(path, strategy).await.unwrap();
        assert_eq!(result.reason, Some(reason));
        assert!(result.preflight.merge_requires_preservation);
        let plan = result.preservation.unwrap();
        assert_eq!(plan.groups.len(), 2);
        assert_eq!(plan.groups[0].restore_order, 1);
        assert_eq!(plan.groups[1].restore_order, 0);
    }
    assert_eq!(git(path, &["show", ":b"]), "staged");
    assert_eq!(
        std::fs::read_to_string(path.join("b")).unwrap(),
        "working\n"
    );
}

#[tokio::test]
async fn operation_pull_preview_clean_has_no_backup_and_merge_overlap_requires_preservation() {
    let dir = repository();
    let path = dir.path();
    let index_path = path.join(".git/index");
    let index_before = std::fs::read(&index_path).unwrap();
    // Retain clean content but invalidate the cached stat. Preview must not
    // refresh the index as a side effect of reading status.
    std::fs::write(path.join("b"), "base\n").unwrap();
    for strategy in [RemotePullStrategy::Merge, RemotePullStrategy::Rebase] {
        let result = preview(path, strategy).await.unwrap();
        assert!(
            result.preflight.is_clean && result.reason.is_none() && result.preservation.is_none()
        );
        assert_eq!(std::fs::read(&index_path).unwrap(), index_before);
    }
    std::fs::write(path.join("a"), "local\n").unwrap();
    let result = preview(path, RemotePullStrategy::Merge).await.unwrap();
    assert_eq!(result.reason, Some(PullPreservationReason::OverwriteRisk));
    assert_eq!(result.preservation.unwrap().groups.len(), 1);
    assert_eq!(std::fs::read_to_string(path.join("a")).unwrap(), "local\n");
}

struct MovingBranches {
    source_branch: bool,
    moved: AtomicBool,
}
impl BranchGitPort for MovingBranches {
    fn validate_name<'a>(&'a self, p: &'a Path, name: &'a str) -> BranchGitFuture<'a, bool> {
        GitBranchAdapter.validate_name(p, name)
    }
    fn list_references<'a>(&'a self, p: &'a Path) -> BranchGitFuture<'a, Vec<BranchReference>> {
        GitBranchAdapter.list_references(p)
    }
    fn unmerged_commit_count<'a>(
        &'a self,
        p: &'a Path,
        a: &'a str,
        b: &'a str,
    ) -> BranchGitFuture<'a, u32> {
        GitBranchAdapter.unmerged_commit_count(p, a, b)
    }
    fn paths_changed_between<'a>(
        &'a self,
        p: &'a Path,
        a: &'a str,
        b: &'a str,
    ) -> BranchGitFuture<'a, Vec<String>> {
        GitBranchAdapter.paths_changed_between(p, a, b)
    }
    fn paths_changed_between_oids<'a>(
        &'a self,
        p: &'a Path,
        a: &'a str,
        b: &'a str,
    ) -> BranchGitFuture<'a, Vec<String>> {
        Box::pin(async move {
            let result = GitBranchAdapter.paths_changed_between_oids(p, a, b).await?;
            if !self.moved.swap(true, Ordering::SeqCst) {
                let args = if self.source_branch {
                    vec!["switch", "--detach", "HEAD"]
                } else {
                    vec!["update-ref", "refs/remotes/origin/main", a]
                };
                let output = Command::new("git")
                    .arg("-C")
                    .arg(p)
                    .args(args)
                    .output()
                    .map_err(|_| GitAdapterError::Failed)?;
                assert!(output.status.success());
            }
            Ok(result)
        })
    }
}

#[tokio::test]
async fn operation_pull_preview_rejects_tracking_or_source_branch_changes_during_review() {
    for source_branch in [false, true] {
        let dir = repository();
        let path = dir.path();
        std::fs::write(path.join("b"), "local\n").unwrap();
        let branches = MovingBranches {
            source_branch,
            moved: AtomicBool::new(false),
        };
        let result = read_pull(
            &GitCommandService::default(),
            &DiffWorktreeAdapter,
            &branches,
            &GitRemoteAdapter,
            "repo",
            path,
            PullPreviewInput {
                strategy: RemotePullStrategy::Merge,
                preservation: PreservationPolicy::Restore,
                shelf_name: "backup",
                shelf_description: "",
            },
        )
        .await;
        assert!(matches!(
            result,
            Err(PreviewError::Pull(pull::PullError::PreflightChanged))
        ));
        assert_eq!(std::fs::read_to_string(path.join("b")).unwrap(), "local\n");
    }
}
