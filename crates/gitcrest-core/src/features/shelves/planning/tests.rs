use super::*;
use crate::{git::command::GitCommandService, storage::diff::DiffWorktreeAdapter};
use std::process::Command;

fn cached_diff(path: &Path) -> Vec<u8> {
    let result = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["diff", "--cached", "--binary"])
        .output()
        .unwrap();
    assert!(result.status.success());
    result.stdout
}

#[tokio::test]
async fn shelf_plan_reviews_all_scopes_and_batches_more_than_one_hundred_files() {
    let repository = super::super::evidence::tests::repository();
    let path = repository.path();
    for index in 0..98 {
        std::fs::write(path.join(format!("new-{index:03}")), "new content\n").unwrap();
    }
    let git = GitCommandService::default();
    let before_index = cached_diff(path);
    let plan = read_plan(&git, &DiffWorktreeAdapter, "repo", path, "backup", "")
        .await
        .unwrap();
    assert_eq!(
        plan.groups
            .iter()
            .map(|g| g.selections.len())
            .collect::<Vec<_>>(),
        vec![100, 1, 1]
    );
    for (index, group) in plan.groups.iter().enumerate() {
        assert_eq!(group.save_order, index as u32);
        assert_eq!(group.restore_order, 2 - index as u32);
        assert!(group.selections.iter().all(|selection| selection.scope
            == if index < 2 {
                DiffScope::WorkingTree
            } else {
                DiffScope::Index
            }));
    }
    assert!(plan.patch_bytes > 0);
    assert!(plan
        .before
        .matches_changes(plan.groups.iter().flat_map(|g| &g.selections).map(|s| (
            s.path.as_str(),
            s.scope,
            s.revision.as_str()
        ))));
    assert_eq!(cached_diff(path), before_index);
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "working a\n"
    );
    assert!(path.join("new-097").exists());
}

#[tokio::test]
async fn shelf_plan_collects_binary_and_rename_blockers_without_changing_git() {
    let repository = super::super::evidence::tests::repository();
    let path = repository.path();
    for name in ["binary-x", "binary-y"] {
        std::fs::write(path.join(name), [0, 1, 2, 3]).unwrap();
    }
    assert!(Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["mv", "b", "renamed"])
        .output()
        .unwrap()
        .status
        .success());
    let before_index = cached_diff(path);
    let result = read_plan(
        &GitCommandService::default(),
        &DiffWorktreeAdapter,
        "repo",
        path,
        "backup",
        "",
    )
    .await;
    let Err(PlanningError::Blocked(blockers)) = result else {
        panic!("expected all unsupported paths to block the complete plan");
    };
    for name in ["binary-x", "binary-y"] {
        assert!(blockers.iter().any(|b| b.path == name
            && b.scope == DiffScope::WorkingTree
            && matches!(
                b.reason,
                BlockerReason::Unsupported(DiffContentStatus::Binary)
            )));
        assert_eq!(std::fs::read(path.join(name)).unwrap(), [0, 1, 2, 3]);
    }
    assert!(
        blockers
            .iter()
            .any(|b| b.path == "renamed"
                && matches!(b.reason, BlockerReason::UnsupportedPathRelation))
    );
    assert_eq!(cached_diff(path), before_index);
    assert_eq!(
        std::fs::read_to_string(path.join("a")).unwrap(),
        "working a\n"
    );
    assert_eq!(
        std::fs::read_to_string(path.join("renamed")).unwrap(),
        "working b\n"
    );
    assert!(path.join("untracked").exists());
}

#[test]
fn shelf_plan_batches_at_patch_storage_limit_and_rejects_oversized_items() {
    let mut batches = Batches {
        name: "backup",
        description: "",
        groups: vec![],
        pending: vec![],
        bytes: 0,
    };
    let selection = |path: &str| ShelfSelection {
        path: path.into(),
        scope: DiffScope::WorkingTree,
        revision: "revision".into(),
        selections: vec![],
    };
    batches.push(selection("a"), MAX_PATCH_BYTES / 2).unwrap();
    batches
        .push(selection("b"), MAX_PATCH_BYTES - MAX_PATCH_BYTES / 2)
        .unwrap();
    batches.push(selection("c"), 1).unwrap();
    assert_eq!(batches.groups[0].selections.len(), 2);
    assert_eq!(batches.pending.len(), 1);
    assert!(batches
        .push(selection("oversized"), MAX_PATCH_BYTES + 1)
        .is_err());
    batches.flush();
    assert_eq!(batches.groups.len(), 2);
}
