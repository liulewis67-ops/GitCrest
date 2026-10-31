use std::{collections::HashSet, path::Path, process::Command};

use super::{
    engine::{NewRun, PipelineEngine, ResumeAction},
    ephemeral::EphemeralContexts,
    worktree::WorktreeWorkspace,
};
use crate::ports::pipelines::PipelineStorePort;
use crate::{
    domain::pipeline::{
        tests::rule, Confirmation, ExecutionMode, PipelineRule, RunStatus, StepState,
    },
    storage::RepositoryStore,
};
use std::sync::Arc;

pub(super) fn git(directory: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(directory)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

pub(super) fn commit_file(directory: &Path, file: &str, content: &str, message: &str) {
    std::fs::write(directory.join(file), content).unwrap();
    git(directory, &["add", file]);
    git(directory, &["commit", "-q", "-m", message]);
}

pub(super) struct Fixture {
    pub(super) _root: tempfile::TempDir,
    pub(super) remote: std::path::PathBuf,
    pub(super) repository: std::path::PathBuf,
    pub(super) data_dir: std::path::PathBuf,
    pub(super) source_oid: String,
}

/// A bare remote with `main`, `uat`, `dev` and a pushed `feature/1`; the local
/// clone sits on a dirty `feature/1`.
pub(super) fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let repository = root.path().join("work");
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "-b", "main"]);
    git(
        root.path(),
        &["clone", "-q", remote.to_str().unwrap(), "work"],
    );
    git(&repository, &["config", "core.autocrlf", "false"]);
    git(&repository, &["config", "user.name", "Test"]);
    git(&repository, &["config", "user.email", "test@example.com"]);
    git(&repository, &["checkout", "-q", "-b", "main"]);
    commit_file(&repository, "base.txt", "base\n", "base");
    for branch in ["uat", "dev"] {
        git(&repository, &["branch", branch]);
    }
    git(&repository, &["checkout", "-q", "-b", "feature/1"]);
    commit_file(&repository, "feature.txt", "feature\n", "feature work");
    git(
        &repository,
        &["push", "-q", "origin", "main", "uat", "dev", "feature/1"],
    );
    let source_oid = git(&repository, &["rev-parse", "HEAD"]);
    // The user keeps working: uncommitted edits and an untracked file.
    std::fs::write(repository.join("base.txt"), "base\nlocal edit\n").unwrap();
    std::fs::write(repository.join("scratch.txt"), "scratch\n").unwrap();
    Fixture {
        _root: root,
        remote,
        repository,
        data_dir,
        source_oid,
    }
}

type Engine = PipelineEngine<RepositoryStore, WorktreeWorkspace>;

fn engine(fixture: &Fixture) -> (Engine, Arc<EphemeralContexts>, Arc<RepositoryStore>) {
    let store = Arc::new(RepositoryStore::default());
    store.insert_test_repository("repo");
    let contexts = Arc::new(EphemeralContexts::default());
    let repository = fixture.repository.clone();
    let workspace = WorktreeWorkspace::new(
        fixture.data_dir.clone(),
        Arc::new(move |_| Some(repository.clone())),
        contexts.clone(),
    );
    (
        PipelineEngine::new(store.clone(), Arc::new(workspace)),
        contexts,
        store,
    )
}

fn auto_rule() -> PipelineRule {
    let mut rule = rule();
    rule.confirmation = Confirmation::Auto;
    rule
}

fn new_run(fixture: &Fixture, rule: PipelineRule) -> NewRun {
    NewRun {
        run_id: "run1".into(),
        repo_id: "repo".into(),
        rule,
        source_branch: "feature/1".into(),
        source_oid: fixture.source_oid.clone(),
        execution_mode: ExecutionMode::TemporaryWorktree,
        hold: false,
        now_ms: 1,
    }
}

fn assert_user_tree_untouched(fixture: &Fixture) {
    assert_eq!(
        git(&fixture.repository, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feature/1"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.repository.join("base.txt")).unwrap(),
        "base\nlocal edit\n"
    );
    assert!(fixture.repository.join("scratch.txt").exists());
    let status = git(&fixture.repository, &["status", "--porcelain"]);
    assert!(status.contains("M base.txt") && status.contains("?? scratch.txt"));
}

fn assert_no_worktree_left(fixture: &Fixture, contexts: &EphemeralContexts) {
    let worktrees = git(&fixture.repository, &["worktree", "list", "--porcelain"]);
    assert_eq!(worktrees.matches("worktree ").count(), 1, "{worktrees}");
    assert!(!fixture.data_dir.join("pipelines/run1").exists());
    assert_eq!(contexts.path("pipeline-run1-0"), None);
    assert_eq!(contexts.path("pipeline-run1-1"), None);
}

#[tokio::test]
async fn two_targets_are_merged_and_pushed_without_touching_the_users_tree() {
    let fixture = fixture();
    let (engine, contexts, store) = engine(&fixture);
    engine
        .create_run(new_run(&fixture, auto_rule()))
        .await
        .unwrap();

    assert_eq!(engine.drive("run1").await, Ok(RunStatus::Succeeded));

    for target in ["uat", "dev"] {
        let subject = git(&fixture.remote, &["log", "-1", "--format=%s", target]);
        assert_eq!(subject, format!("Merge branch 'feature/1' into {target}"));
        let parents = git(&fixture.remote, &["log", "-1", "--format=%P", target]);
        assert_eq!(parents.split(' ').count(), 2, "{target} has a merge commit");
        let contains = git(
            &fixture.remote,
            &[
                "branch",
                "--contains",
                &fixture.source_oid,
                "--list",
                target,
            ],
        );
        assert!(contains.contains(target));
        // The local branch followed the push because nothing had it checked out.
        assert_eq!(
            git(
                &fixture.repository,
                &["rev-parse", &format!("refs/heads/{target}")]
            ),
            git(&fixture.remote, &["rev-parse", target])
        );
    }
    assert_user_tree_untouched(&fixture);
    assert_no_worktree_left(&fixture, &contexts);
    let stored = store.pipeline_run("run1").unwrap().unwrap();
    assert!(stored
        .steps
        .iter()
        .all(|step| step.state == StepState::Done && step.merge_oid.is_some()));
}

#[tokio::test]
async fn an_already_merged_target_is_up_to_date_and_not_pushed() {
    let fixture = fixture();
    git(&fixture.repository, &["stash", "-u", "-q"]);
    git(&fixture.repository, &["checkout", "-q", "uat"]);
    git(
        &fixture.repository,
        &["merge", "-q", "--no-ff", "-m", "pre-merge", "feature/1"],
    );
    git(&fixture.repository, &["push", "-q", "origin", "uat"]);
    git(&fixture.repository, &["checkout", "-q", "feature/1"]);
    git(&fixture.repository, &["stash", "pop", "-q"]);
    let uat_before = git(&fixture.remote, &["rev-parse", "uat"]);
    let (engine, contexts, store) = engine(&fixture);
    engine
        .create_run(new_run(&fixture, auto_rule()))
        .await
        .unwrap();

    assert_eq!(engine.drive("run1").await, Ok(RunStatus::Succeeded));

    assert_eq!(git(&fixture.remote, &["rev-parse", "uat"]), uat_before);
    let stored = store.pipeline_run("run1").unwrap().unwrap();
    assert_eq!(stored.steps[0].state, StepState::UpToDate);
    assert_eq!(stored.steps[1].state, StepState::Done);
    assert_no_worktree_left(&fixture, &contexts);
}

#[tokio::test]
async fn a_conflict_waits_in_the_worktree_and_resolving_it_continues_to_the_next_target() {
    let fixture = fixture();
    // Make uat conflict with feature/1 on feature.txt.
    git(&fixture.repository, &["stash", "-u", "-q"]);
    git(&fixture.repository, &["checkout", "-q", "uat"]);
    commit_file(
        &fixture.repository,
        "feature.txt",
        "uat version\n",
        "uat edit",
    );
    git(&fixture.repository, &["push", "-q", "origin", "uat"]);
    git(&fixture.repository, &["checkout", "-q", "feature/1"]);
    git(&fixture.repository, &["stash", "pop", "-q"]);
    let (engine, contexts, _store) = engine(&fixture);
    engine
        .create_run(new_run(&fixture, auto_rule()))
        .await
        .unwrap();

    assert_eq!(
        engine.drive("run1").await,
        Ok(RunStatus::WaitingForConflicts)
    );

    // The conflict window serves the ephemeral context, which points at the worktree.
    let worktree = contexts
        .path("pipeline-run1-0")
        .expect("context registered");
    assert!(worktree.starts_with(fixture.data_dir.join("pipelines/run1")));
    assert!(git(&worktree, &["status", "--porcelain"]).contains("AA feature.txt"));
    assert_user_tree_untouched(&fixture);

    // Resolve like the conflict window would: write the file, stage it, conclude the merge.
    commit_file_resolving(&worktree);

    assert_eq!(
        engine.resume("run1", ResumeAction::ConflictsResolved).await,
        Ok(RunStatus::Succeeded)
    );
    assert_eq!(
        git(&fixture.remote, &["show", "uat:feature.txt"]),
        "resolved"
    );
    let dev_subject = git(&fixture.remote, &["log", "-1", "--format=%s", "dev"]);
    assert_eq!(dev_subject, "Merge branch 'feature/1' into dev");
    assert_no_worktree_left(&fixture, &contexts);
    assert_user_tree_untouched(&fixture);
}

fn commit_file_resolving(worktree: &Path) {
    std::fs::write(worktree.join("feature.txt"), "resolved\n").unwrap();
    git(worktree, &["add", "feature.txt"]);
    git(worktree, &["commit", "-q", "--no-edit"]);
}

#[tokio::test]
async fn skipping_a_conflicting_target_aborts_the_merge_and_removes_the_worktree() {
    let fixture = fixture();
    git(&fixture.repository, &["stash", "-u", "-q"]);
    git(&fixture.repository, &["checkout", "-q", "uat"]);
    commit_file(
        &fixture.repository,
        "feature.txt",
        "uat version\n",
        "uat edit",
    );
    git(&fixture.repository, &["push", "-q", "origin", "uat"]);
    let uat_remote = git(&fixture.remote, &["rev-parse", "uat"]);
    git(&fixture.repository, &["checkout", "-q", "feature/1"]);
    git(&fixture.repository, &["stash", "pop", "-q"]);
    let (engine, contexts, _store) = engine(&fixture);
    engine
        .create_run(new_run(&fixture, auto_rule()))
        .await
        .unwrap();
    engine.drive("run1").await.unwrap();

    assert_eq!(
        engine.resume("run1", ResumeAction::SkipTarget).await,
        Ok(RunStatus::PartiallySucceeded)
    );

    assert_eq!(git(&fixture.remote, &["rev-parse", "uat"]), uat_remote);
    assert_no_worktree_left(&fixture, &contexts);
    assert_user_tree_untouched(&fixture);
}

#[tokio::test]
async fn a_target_that_moves_between_fetch_and_push_is_not_overwritten() {
    use super::workspace::{PipelineWorkspace, PublishOutcome};
    let fixture = fixture();
    let (engine, contexts, _store) = engine(&fixture);
    let run = engine
        .create_run(new_run(&fixture, auto_rule()))
        .await
        .unwrap();
    let workspace = WorktreeWorkspace::new(
        fixture.data_dir.clone(),
        {
            let repository = fixture.repository.clone();
            Arc::new(move |_| Some(repository.clone()))
        },
        contexts.clone(),
    );
    let mut step = run.steps[0].clone();
    let prepared = workspace.prepare(&run, &step).await.unwrap();
    step.lease_oid = Some(prepared.lease_oid);
    workspace.merge(&run, &step, "merge").await.unwrap();

    // Someone else pushes to uat after our fetch.
    let other = fixture.data_dir.parent().unwrap().join("other");
    git(
        fixture.data_dir.parent().unwrap(),
        &["clone", "-q", fixture.remote.to_str().unwrap(), "other"],
    );
    git(&other, &["checkout", "-q", "uat"]);
    commit_file(&other, "other.txt", "other\n", "someone else");
    git(&other, &["push", "-q", "origin", "uat"]);
    let moved = git(&fixture.remote, &["rev-parse", "uat"]);

    assert_eq!(
        workspace.publish(&run, &step).await,
        Ok(PublishOutcome::LeaseRejected)
    );
    assert_eq!(git(&fixture.remote, &["rev-parse", "uat"]), moved);
    workspace
        .finish(&run, &step, super::workspace::StepOutcome::Failed)
        .await
        .unwrap();
}

#[tokio::test]
async fn orphaned_worktree_folders_are_swept_and_active_runs_are_kept() {
    let fixture = fixture();
    let (_engine, contexts, _store) = engine(&fixture);
    let workspace = WorktreeWorkspace::new(
        fixture.data_dir.clone(),
        {
            let repository = fixture.repository.clone();
            Arc::new(move |_| Some(repository.clone()))
        },
        contexts,
    );
    for run in ["orphan", "alive"] {
        std::fs::create_dir_all(fixture.data_dir.join("pipelines").join(run).join("0")).unwrap();
    }
    let alive: HashSet<String> = ["alive".to_string()].into();

    workspace
        .sweep_orphans(&alive, std::slice::from_ref(&fixture.repository))
        .await;

    assert!(!fixture.data_dir.join("pipelines/orphan").exists());
    assert!(fixture.data_dir.join("pipelines/alive").exists());
}
