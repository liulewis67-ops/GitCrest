use std::path::Path;

use crate::{
    domain::{
        error::WorkflowError,
        workflow::{WorkflowAction, WorkflowOperation},
    },
    ports::git::GitReadPort,
};

#[derive(Clone, Debug)]
pub struct WorkflowPreflight {
    pub repo_id: String,
    pub action: WorkflowAction,
    pub head_oid: Option<String>,
    pub target_oid: String,
    pub target_subject: String,
    pub operation_in_progress: Option<WorkflowOperation>,
    pub is_clean: bool,
    pub dirty_paths: Vec<String>,
    pub omitted_dirty_path_count: u32,
    pub conflicted_paths: Vec<String>,
    pub omitted_conflicted_path_count: u32,
    pub can_start: bool,
    pub merge_relation: Option<crate::domain::workflow::MergeRelation>,
}

#[derive(Clone, Debug)]
pub struct WorkflowRecoveryPreflight {
    pub repo_id: String,
    pub task_id: String,
    pub operation: WorkflowOperation,
    pub head_oid: Option<String>,
    pub dirty_paths: Vec<String>,
    pub omitted_dirty_path_count: u32,
    pub conflicted_paths: Vec<String>,
    pub omitted_conflicted_path_count: u32,
    pub can_continue: bool,
    pub can_skip: bool,
    pub can_abort: bool,
}

pub async fn read_preflight<G: GitReadPort>(
    git: &G,
    repo_id: String,
    repository_path: &Path,
    action: WorkflowAction,
    target: &str,
) -> Result<WorkflowPreflight, WorkflowError> {
    if !(4..=64).contains(&target.len()) || !target.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorkflowError::InvalidTarget);
    }
    let target_oid = git
        .resolve_commit_target(repository_path, target)
        .await
        .map_err(|error| match error {
            WorkflowError::GitFailed => WorkflowError::CommitNotFound,
            other => other,
        })?;
    let target_subject = git
        .read_commit_subject(repository_path, &target_oid)
        .await?;
    let head_oid = git.read_head_oid(repository_path).await?;
    let state = git.read_worktree_state(repository_path).await?;
    let operation_in_progress = state.operation;
    let is_clean = state.dirty_paths.is_empty() && operation_in_progress.is_none();
    let merge_relation = match (action, head_oid.as_deref()) {
        (WorkflowAction::Merge, Some(head)) => Some(
            git.read_merge_relation(repository_path, head, &target_oid)
                .await?,
        ),
        _ => None,
    };
    let already_merged = merge_relation
        .is_some_and(|relation| relation.kind == crate::domain::workflow::MergeKind::UpToDate);
    let can_start = head_oid.is_some()
        && operation_in_progress.is_none()
        && state.conflicted_paths.is_empty()
        && (is_clean || action == WorkflowAction::Merge)
        && !already_merged;
    Ok(WorkflowPreflight {
        repo_id,
        action,
        head_oid,
        target_oid,
        target_subject,
        operation_in_progress,
        is_clean,
        dirty_paths: state.dirty_paths,
        omitted_dirty_path_count: state.omitted_dirty_path_count,
        conflicted_paths: state.conflicted_paths,
        omitted_conflicted_path_count: state.omitted_conflicted_path_count,
        can_start,
        merge_relation,
    })
}

pub async fn read_recovery_preflight<G: GitReadPort>(
    git: &G,
    repo_id: String,
    task_id: String,
    repository_path: &Path,
) -> Result<WorkflowRecoveryPreflight, WorkflowError> {
    let head_oid = git.read_head_oid(repository_path).await?;
    let state = git.read_worktree_state(repository_path).await?;
    let operation = state.operation.ok_or(WorkflowError::NoActiveOperation)?;
    let only_conflicts_are_dirty = state.dirty_paths.iter().all(|path| {
        state
            .conflicted_paths
            .iter()
            .any(|conflicted| conflicted == path)
    }) && state.omitted_dirty_path_count == 0;
    let can_continue = state.conflicted_paths.is_empty();
    Ok(WorkflowRecoveryPreflight {
        repo_id,
        task_id,
        operation,
        head_oid,
        dirty_paths: state.dirty_paths,
        omitted_dirty_path_count: state.omitted_dirty_path_count,
        conflicted_paths: state.conflicted_paths,
        omitted_conflicted_path_count: state.omitted_conflicted_path_count,
        can_continue,
        can_skip: matches!(
            operation,
            WorkflowOperation::CherryPick | WorkflowOperation::Revert | WorkflowOperation::Rebase
        ) && only_conflicts_are_dirty,
        can_abort: only_conflicts_are_dirty,
    })
}

pub async fn read_shelf_apply_preflight<G: GitReadPort>(
    git: &G,
    repo_id: String,
    task_id: String,
    repository_path: &Path,
) -> Result<WorkflowRecoveryPreflight, WorkflowError> {
    let head_oid = git.read_head_oid(repository_path).await?;
    let state = git.read_worktree_state(repository_path).await?;
    if state.operation.is_some() {
        return Err(WorkflowError::NoActiveOperation);
    }
    Ok(WorkflowRecoveryPreflight {
        repo_id,
        task_id,
        operation: WorkflowOperation::ShelfApply,
        head_oid,
        dirty_paths: state.dirty_paths,
        omitted_dirty_path_count: state.omitted_dirty_path_count,
        can_continue: state.conflicted_paths.is_empty() && state.omitted_conflicted_path_count == 0,
        can_skip: false,
        can_abort: false,
        conflicted_paths: state.conflicted_paths,
        omitted_conflicted_path_count: state.omitted_conflicted_path_count,
    })
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use tempfile::tempdir;

    use super::read_preflight;
    use crate::domain::workflow::{WorkflowAction, WorkflowOperation};
    use crate::git::status::parse_status;

    #[test]
    fn parses_worktree_and_conflict_paths_with_a_bounded_list() {
        let mut status = b"1 .M N... 100644 100644 100644 1111111 1111111 dirty.txt\0u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.txt\0".to_vec();
        for index in 0..205 {
            status.extend_from_slice(format!("? path-{index}.txt\0").as_bytes());
        }
        let (dirty, omitted_dirty, conflicted, omitted_conflicted) = parse_status(&status).unwrap();
        assert_eq!(dirty.len(), 200);
        assert_eq!(omitted_dirty, 7);
        assert_eq!(conflicted, ["conflict.txt"]);
        assert_eq!(omitted_conflicted, 0);
    }

    #[tokio::test]
    async fn preflight_resolves_commit_targets_and_reports_dirty_and_active_operations() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let git = |arguments: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(root)
                .args(arguments)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "user.name", "GitCrest Test"]);
        git(&["config", "user.email", "test@example.test"]);
        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        git(&["add", "base.txt"]);
        git(&["commit", "--quiet", "-m", "base commit"]);
        let oid = String::from_utf8(git(&["rev-parse", "HEAD"]))
            .unwrap()
            .trim()
            .to_owned();
        let git_service = crate::git::command::GitCommandService::default();

        let clean = read_preflight(
            &git_service,
            "repo_fixture".into(),
            root,
            WorkflowAction::Merge,
            &oid,
        )
        .await
        .unwrap();
        // Merging the commit HEAD already points at changes nothing, so it cannot start.
        assert!(!clean.can_start);
        assert_eq!(
            clean.merge_relation.map(|relation| relation.kind),
            Some(crate::domain::workflow::MergeKind::UpToDate)
        );
        assert_eq!(clean.head_oid.as_deref(), Some(oid.as_str()));
        assert_eq!(clean.target_oid, oid);
        assert_eq!(clean.target_subject, "base commit");

        std::fs::write(root.join("dirty.txt"), "local edit\n").unwrap();
        let dirty = read_preflight(
            &git_service,
            "repo_fixture".into(),
            root,
            WorkflowAction::CherryPick,
            &oid,
        )
        .await
        .unwrap();
        assert!(!dirty.can_start);
        assert_eq!(dirty.dirty_paths, ["dirty.txt"]);

        std::fs::remove_file(root.join("dirty.txt")).unwrap();
        git(&["checkout", "--quiet", "-b", "side"]);
        std::fs::write(root.join("base.txt"), "side\n").unwrap();
        git(&["commit", "--quiet", "-am", "side commit"]);
        git(&["checkout", "--quiet", "main"]);
        std::fs::write(root.join("base.txt"), "main\n").unwrap();
        git(&["commit", "--quiet", "-am", "main commit"]);
        let diverged = read_preflight(
            &git_service,
            "repo_fixture".into(),
            root,
            WorkflowAction::Merge,
            "side",
        )
        .await;
        // Branch names are not accepted as targets; only object IDs are.
        assert!(diverged.is_err());
        let side_head = String::from_utf8(git(&["rev-parse", "side"]))
            .unwrap()
            .trim()
            .to_owned();
        let diverged = read_preflight(
            &git_service,
            "repo_fixture".into(),
            root,
            WorkflowAction::Merge,
            &side_head,
        )
        .await
        .unwrap();
        let relation = diverged.merge_relation.unwrap();
        assert_eq!(
            relation.kind,
            crate::domain::workflow::MergeKind::MergeCommit
        );
        assert_eq!(relation.incoming_commit_count, 1);
        let conflict = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["merge", "side"])
            .output()
            .unwrap();
        assert!(!conflict.status.success());
        let side_oid = String::from_utf8(git(&["rev-parse", "side"]))
            .unwrap()
            .trim()
            .to_owned();
        let active = read_preflight(
            &git_service,
            "repo_fixture".into(),
            root,
            WorkflowAction::Revert,
            &side_oid,
        )
        .await
        .unwrap();
        assert!(!active.can_start);
        assert_eq!(active.operation_in_progress, Some(WorkflowOperation::Merge));
        assert_eq!(active.conflicted_paths, ["base.txt"]);
    }
}
