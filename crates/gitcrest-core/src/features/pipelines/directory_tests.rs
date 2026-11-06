use std::{collections::HashSet, path::Path, sync::Arc, time::Duration};

use super::{
    ephemeral::{context_id, EphemeralContexts},
    workspace::{PipelineWorkspace, StepOutcome},
    worktree::WorktreeWorkspace,
    worktree_tests::{fixture, git, Fixture},
};
use crate::{
    domain::{
        operation::*,
        pipeline::{
            tests::{run, step},
            PipelineRun, StepState,
        },
    },
    execution::write_access::WriteAccess,
    features::repositories::RepositoryTargetReader,
    git::repository::GitRepositoryAdapter,
    storage::{repository_paths::RepositoryFilesystemAdapter, RepositoryStore},
};

fn setup() -> (
    Fixture,
    Arc<RepositoryStore>,
    WriteAccess,
    Arc<WorktreeWorkspace>,
    Arc<EphemeralContexts>,
    PipelineRun,
) {
    let fixture = fixture();
    let store = Arc::new(RepositoryStore::default());
    store.insert_test_repository_at("repo", &fixture.repository);
    let targets = RepositoryTargetReader::new(
        store.clone(),
        Arc::new(GitRepositoryAdapter),
        Arc::new(RepositoryFilesystemAdapter),
    );
    let access = WriteAccess::new(Arc::new(targets), store.clone());
    let contexts = Arc::new(EphemeralContexts::default());
    let source = fixture.repository.clone();
    let workspace = Arc::new(
        WorktreeWorkspace::new(
            fixture.data_dir.clone(),
            Arc::new(move |_| Some(source.clone())),
            contexts.clone(),
        )
        .with_write_access(Some(access.clone())),
    );
    let mut run = run(vec![step(0, StepState::Merging)]);
    run.steps[0].target_branch = "uat".into();
    run.source_oid = fixture.source_oid.clone();
    (fixture, store, access, workspace, contexts, run)
}

fn link(target: &Path, path: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, path).unwrap();
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(path.to_string_lossy().replace('/', "\\"))
            .arg(target.to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

fn unlink(path: &Path) {
    #[cfg(unix)]
    std::fs::remove_file(path).unwrap();
    #[cfg(windows)]
    std::fs::remove_dir(path).unwrap();
}

fn operation(repo: &str) -> NewOperation {
    NewOperation {
        operation_id: "nested-owner".into(),
        request_id: "request".into(),
        repo_id: repo.into(),
        resource_key: "ignored".into(),
        request: OperationRequest {
            command: OperationCommand::Checkout {
                target: "main".into(),
                target_oid: "oid".into(),
            },
            source_head_oid: None,
            source_branch: None,
            changes_fingerprint: "changes".into(),
            preservation: PreservationPolicy::Restore,
        },
    }
}

#[tokio::test]
async fn normal_prepare_and_cleanup_work_with_directory_protection_enabled() {
    let (fixture, _, _, workspace, contexts, run) = setup();
    let prepared = workspace.prepare(&run, &run.steps[0]).await.unwrap();
    assert!(Path::new(prepared.workspace_path.as_ref().unwrap())
        .join(".git")
        .exists());
    assert!(contexts.path(&prepared.repo_context).is_some());
    workspace
        .finish(&run, &run.steps[0], StepOutcome::Done)
        .await
        .unwrap();
    assert!(!fixture.data_dir.join("pipelines/run").exists());
    assert!(contexts.path(&prepared.repo_context).is_none());
}

#[tokio::test]
async fn linked_run_and_step_paths_are_preserved_instead_of_followed() {
    let (fixture, _, _, workspace, contexts, mut run) = setup();
    let outside = fixture._root.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("valuable"), "keep").unwrap();
    let root = fixture.data_dir.join("pipelines");
    std::fs::create_dir_all(&root).unwrap();
    link(&outside, &root.join("run"));
    assert!(workspace.prepare(&run, &run.steps[0]).await.is_err());
    workspace
        .sweep_orphans(&HashSet::new(), std::slice::from_ref(&fixture.repository))
        .await;
    assert!(root.join("run").exists());
    unlink(&root.join("run"));
    std::fs::create_dir(root.join("run")).unwrap();
    link(&outside, &root.join("run/0"));
    let context = context_id(&run.run_id, 0);
    contexts.register(&context, &root.join("run/0"));
    assert!(workspace
        .finish(&run, &run.steps[0], StepOutcome::Done)
        .await
        .is_err());
    assert!(
        contexts.path(&context).is_some(),
        "failed cleanup retains recovery context"
    );
    assert_eq!(
        std::fs::read_to_string(outside.join("valuable")).unwrap(),
        "keep"
    );
    unlink(&root.join("run/0"));
    run.run_id = "../../outside".into();
    assert!(workspace.prepare(&run, &run.steps[0]).await.is_err());
    assert_eq!(
        std::fs::read_to_string(outside.join("valuable")).unwrap(),
        "keep"
    );
}

#[tokio::test]
async fn sweep_rejects_a_linked_management_root_and_keeps_active_runs() {
    let (fixture, _, _, workspace, _, _) = setup();
    let outside = fixture._root.path().join("outside");
    std::fs::create_dir_all(outside.join("orphan")).unwrap();
    std::fs::write(outside.join("orphan/valuable"), "keep").unwrap();
    std::fs::create_dir_all(&fixture.data_dir).unwrap();
    let root = fixture.data_dir.join("pipelines");
    link(&outside, &root);
    workspace
        .sweep_orphans(&HashSet::new(), std::slice::from_ref(&fixture.repository))
        .await;
    assert!(outside.join("orphan/valuable").exists());
    unlink(&root);
    for name in ["alive", "orphan"] {
        std::fs::create_dir_all(root.join(name)).unwrap();
    }
    link(&outside, &root.join("orphan/nested-link"));
    let active = HashSet::from(["alive".into()]);
    workspace
        .sweep_orphans(&active, std::slice::from_ref(&fixture.repository))
        .await;
    assert!(root.join("alive").exists());
    assert!(!root.join("orphan").exists());
    assert!(
        outside.join("orphan/valuable").exists(),
        "recursive removal must preserve a nested link's target"
    );
}

#[tokio::test]
async fn nested_owner_blocks_prepare_finish_and_orphan_sweep() {
    let (fixture, store, access, workspace, contexts, run) = setup();
    let directory = fixture.data_dir.join("pipelines/run/0");
    let nested = directory.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "--quiet"]);
    std::fs::write(nested.join("valuable"), "keep").unwrap();
    store.insert_test_repository_at("nested", &nested);
    access.claim(operation("nested")).await.unwrap();
    let context = context_id(&run.run_id, 0);
    contexts.register(&context, &directory);
    assert!(workspace.prepare(&run, &run.steps[0]).await.is_err());
    assert!(workspace
        .finish(&run, &run.steps[0], StepOutcome::Done)
        .await
        .is_err());
    workspace
        .sweep_orphans(&HashSet::new(), std::slice::from_ref(&fixture.repository))
        .await;
    assert_eq!(
        std::fs::read_to_string(nested.join("valuable")).unwrap(),
        "keep"
    );
    assert!(contexts.path(&context).is_some());
}

#[tokio::test]
async fn orphan_sweep_preserves_a_registered_repository_inside_the_candidate() {
    let (fixture, store, _, workspace, _, _) = setup();
    let nested = fixture.data_dir.join("pipelines/orphan/independent");
    std::fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "--quiet"]);
    std::fs::write(nested.join("valuable"), "keep").unwrap();
    store.insert_test_repository_at("nested", &nested);
    workspace
        .sweep_orphans(
            &HashSet::new(),
            &[fixture.repository.clone(), nested.clone()],
        )
        .await;
    assert_eq!(
        std::fs::read_to_string(nested.join("valuable")).unwrap(),
        "keep"
    );
}

#[tokio::test]
async fn cleanup_waits_for_a_nested_writer_and_rechecks_layout_after_waiting() {
    let (fixture, store, access, workspace, _, run) = setup();
    let directory = fixture.data_dir.join("pipelines/run/0");
    let nested = directory.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    git(&nested, &["init", "--quiet"]);
    store.insert_test_repository_at("nested", &nested);
    let write = access.enter("nested").await.unwrap();
    let shared = workspace.clone();
    let mut finish =
        tokio::spawn(async move { shared.finish(&run, &run.steps[0], StepOutcome::Done).await });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut finish)
            .await
            .is_err()
    );
    assert!(directory.exists());
    let preserved = fixture._root.path().join("preserved");
    std::fs::rename(&directory, &preserved).unwrap();
    let outside = fixture._root.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("valuable"), "keep").unwrap();
    link(&outside, &directory);
    drop(write);
    assert!(tokio::time::timeout(Duration::from_secs(10), finish)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(preserved.join("nested/.git").exists());
    assert_eq!(
        std::fs::read_to_string(outside.join("valuable")).unwrap(),
        "keep"
    );
    unlink(&directory);
}

struct UnavailableCatalog;
impl crate::ports::repository::RepositoryCatalogPort for UnavailableCatalog {
    fn save_opened(
        &self,
        _: crate::domain::repository::RepositoryRecord,
    ) -> Result<crate::domain::repository::RepositoryRecord, crate::domain::error::RepositoryError>
    {
        Err(crate::domain::error::RepositoryError::StorageUnavailable)
    }
    fn refresh_existing(
        &self,
        _: &str,
        _: crate::domain::repository::RepositoryRecord,
    ) -> Result<
        Option<crate::domain::repository::RepositoryRecord>,
        crate::domain::error::RepositoryError,
    > {
        Err(crate::domain::error::RepositoryError::StorageUnavailable)
    }
    fn mark_opened(
        &self,
        _: &str,
        _: i64,
    ) -> Result<
        Option<crate::domain::repository::RepositoryRecord>,
        crate::domain::error::RepositoryError,
    > {
        Err(crate::domain::error::RepositoryError::StorageUnavailable)
    }
    fn get(
        &self,
        _: &str,
    ) -> Result<
        Option<crate::domain::repository::RepositoryRecord>,
        crate::domain::error::RepositoryError,
    > {
        Err(crate::domain::error::RepositoryError::StorageUnavailable)
    }
    fn list(
        &self,
    ) -> Result<
        Vec<crate::domain::repository::RepositoryRecord>,
        crate::domain::error::RepositoryError,
    > {
        Err(crate::domain::error::RepositoryError::StorageUnavailable)
    }
    fn set_favorite(
        &self,
        _: &str,
        _: bool,
    ) -> Result<
        Option<crate::domain::repository::RepositoryRecord>,
        crate::domain::error::RepositoryError,
    > {
        Err(crate::domain::error::RepositoryError::StorageUnavailable)
    }
    fn forget(&self, _: &str) -> Result<bool, crate::domain::error::RepositoryError> {
        Err(crate::domain::error::RepositoryError::StorageUnavailable)
    }
}

#[tokio::test]
async fn startup_does_not_sweep_when_the_repository_catalog_cannot_be_read() {
    let root = tempfile::tempdir().unwrap();
    let candidate = root.path().join("pipelines/orphan");
    std::fs::create_dir_all(&candidate).unwrap();
    std::fs::write(candidate.join("valuable"), "keep").unwrap();
    let store = Arc::new(RepositoryStore::default());
    let catalog = Arc::new(UnavailableCatalog);
    let targets = RepositoryTargetReader::new(
        catalog.clone(),
        Arc::new(GitRepositoryAdapter),
        Arc::new(RepositoryFilesystemAdapter),
    );
    let service = super::service::PipelineService::new(
        store,
        catalog,
        Arc::new(EphemeralContexts::default()),
        crate::events::publisher::EventBus::default(),
        root.path().into(),
        crate::execution::TaskService::default(),
        targets,
        crate::git::command::GitCommandService::default(),
    );
    service.recover_on_startup().await;
    assert_eq!(
        std::fs::read_to_string(candidate.join("valuable")).unwrap(),
        "keep"
    );
}
