use super::write_access_api_tests::{fixture, operation};
use super::*;
use crate::execution::TaskFailure;
use std::{path::Path, time::Duration};
use tokio::sync::oneshot;

fn git(path: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Directory Test",
            "-c",
            "user.email=directory@example.invalid",
            "-C",
        ])
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn seed(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    git(path, &["init", "--quiet"]);
    git(path, &["commit", "--quiet", "--allow-empty", "-m", "seed"]);
    git(path, &["branch", "feature"]);
}

async fn submit(app: &Router, repo: &str, action: &str, body: serde_json::Value) -> String {
    let response = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo}/worktrees/{action}"),
            &body.to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    json_body(response).await["taskId"].as_str().unwrap().into()
}

async fn hold_queue(state: &AppState, repo: &str) -> oneshot::Sender<()> {
    let key = state
        .repository_targets
        .task_target(repo)
        .await
        .unwrap()
        .resource_key;
    let (started, ready) = oneshot::channel();
    let (release, released) = oneshot::channel();
    state
        .tasks
        .submit(Some(repo.into()), None, key, "testHold", |_| async move {
            started.send(()).unwrap();
            released.await.unwrap();
            Ok::<Option<String>, TaskFailure>(None)
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), ready)
        .await
        .unwrap()
        .unwrap();
    release
}

#[tokio::test]
async fn worktree_creation_cannot_write_inside_another_operations_root() {
    let (source, state, repo, access) = fixture().await;
    seed(source.path());
    let other = tempfile::tempdir().unwrap();
    seed(other.path());
    let owner = state
        .repositories
        .open_path(other.path().to_str().unwrap())
        .await
        .unwrap();
    access.claim(operation(&owner.repo_id)).await.unwrap();
    let destination = other.path().join("new-worktree");
    let app = app_router(state, None);
    let task = submit(
        &app,
        &repo,
        "add",
        serde_json::json!({"branch":"feature", "path": destination}),
    )
    .await;
    let result = wait_for_task(&app, &task).await;
    assert_eq!(result["status"], "failed", "{result}");
    assert_eq!(result["failureCode"], "PRECONDITION_CHANGED");
    assert!(!destination.exists());
    assert!(git(source.path(), &["show-ref", "refs/heads/feature"]).contains("refs/heads/feature"));
}

#[tokio::test]
async fn creating_a_branch_in_a_protected_folder_does_not_create_the_branch() {
    let (source, state, repo, access) = fixture().await;
    seed(source.path());
    let other = tempfile::tempdir().unwrap();
    seed(other.path());
    let owner = state
        .repositories
        .open_path(other.path().to_str().unwrap())
        .await
        .unwrap();
    access.claim(operation(&owner.repo_id)).await.unwrap();
    let destination = other.path().join("new-worktree");
    let app = app_router(state, None);
    let response = app
        .clone()
        .oneshot(json_request(
            Method::POST,
            &format!("/api/v1/repositories/{repo}/branches"),
            &serde_json::json!({"name":"must-not-exist", "worktreePath":destination}).to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let task = json_body(response).await;
    let result = wait_for_task(&app, task["taskId"].as_str().unwrap()).await;
    assert_eq!(result["status"], "failed", "{result}");
    assert_eq!(result["failureCode"], "PRECONDITION_CHANGED");
    assert!(!destination.exists());
    assert!(!git(source.path(), &["branch", "--list", "must-not-exist"]).contains("must-not-exist"));
}

#[tokio::test]
async fn force_removal_preserves_a_nested_repository_with_an_owner() {
    let (source, state, repo, access) = fixture().await;
    seed(source.path());
    let external = tempfile::tempdir().unwrap();
    let linked = external.path().join("linked");
    git(
        source.path(),
        &[
            "worktree",
            "add",
            "--quiet",
            linked.to_str().unwrap(),
            "feature",
        ],
    );
    let nested = linked.join("nested");
    seed(&nested);
    std::fs::write(nested.join("valuable.txt"), "keep").unwrap();
    let nested_repo = state
        .repositories
        .open_path(nested.to_str().unwrap())
        .await
        .unwrap();
    access.claim(operation(&nested_repo.repo_id)).await.unwrap();
    let app = app_router(state, None);
    let task = submit(
        &app,
        &repo,
        "remove",
        serde_json::json!({"path":linked, "force":true}),
    )
    .await;
    let result = wait_for_task(&app, &task).await;
    assert_eq!(result["status"], "failed", "{result}");
    assert_eq!(
        std::fs::read_to_string(nested.join("valuable.txt")).unwrap(),
        "keep"
    );
    assert!(git(source.path(), &["worktree", "list", "--porcelain"])
        .contains("branch refs/heads/feature"));
}

#[tokio::test]
async fn linked_worktree_removal_can_upgrade_its_own_location_scope() {
    let (source, state, repo, _) = fixture().await;
    seed(source.path());
    let external = tempfile::tempdir().unwrap();
    let linked = external.path().join("linked");
    git(
        source.path(),
        &[
            "worktree",
            "add",
            "--quiet",
            linked.to_str().unwrap(),
            "feature",
        ],
    );
    let app = app_router(state, None);
    let task = submit(&app, &repo, "remove", serde_json::json!({"path":linked})).await;
    let result = wait_for_task(&app, &task).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    assert!(!linked.exists());
    assert!(!git(source.path(), &["worktree", "list", "--porcelain"])
        .contains("branch refs/heads/feature"));
}

#[tokio::test]
async fn queued_creation_rechecks_that_the_destination_is_empty() {
    let (source, state, repo, _) = fixture().await;
    seed(source.path());
    let external = tempfile::tempdir().unwrap();
    let linked = external.path().join("linked");
    let release = hold_queue(&state, &repo).await;
    let app = app_router(state, None);
    let task = submit(
        &app,
        &repo,
        "add",
        serde_json::json!({"branch":"feature", "path":linked}),
    )
    .await;
    std::fs::create_dir(&linked).unwrap();
    std::fs::write(linked.join("arrived.txt"), "preserve").unwrap();
    release.send(()).unwrap();
    let result = wait_for_task(&app, &task).await;
    assert_eq!(result["status"], "failed", "{result}");
    assert_eq!(
        std::fs::read_to_string(linked.join("arrived.txt")).unwrap(),
        "preserve"
    );
    assert!(!linked.join(".git").exists());
}

#[tokio::test]
async fn queued_removal_rechecks_the_registered_branch_and_head() {
    let (source, state, repo, _) = fixture().await;
    seed(source.path());
    let external = tempfile::tempdir().unwrap();
    let linked = external.path().join("linked");
    git(
        source.path(),
        &[
            "worktree",
            "add",
            "--quiet",
            linked.to_str().unwrap(),
            "feature",
        ],
    );
    let release = hold_queue(&state, &repo).await;
    let app = app_router(state, None);
    let task = submit(
        &app,
        &repo,
        "remove",
        serde_json::json!({"path":linked, "force":true}),
    )
    .await;
    git(&linked, &["checkout", "--quiet", "-b", "replacement"]);
    git(
        &linked,
        &["commit", "--quiet", "--allow-empty", "-m", "new head"],
    );
    release.send(()).unwrap();
    let result = wait_for_task(&app, &task).await;
    assert_eq!(result["status"], "failed", "{result}");
    assert_eq!(result["failureCode"], "PRECONDITION_CHANGED");
    assert!(linked.exists());
    assert_eq!(git(&linked, &["branch", "--show-current"]), "replacement");
}

#[tokio::test]
async fn directory_effects_delay_owner_registration_for_the_containing_repository() {
    let (source, state, repo, access) = fixture().await;
    seed(source.path());
    let other = tempfile::tempdir().unwrap();
    seed(other.path());
    let owner = state
        .repositories
        .open_path(other.path().to_str().unwrap())
        .await
        .unwrap();
    let destination = other.path().join("new-worktree");
    let key = state
        .repository_targets
        .task_target(&repo)
        .await
        .unwrap()
        .resource_key;
    let (started, ready) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let task_repo = repo.clone();
    let task = state
        .tasks
        .submit(
            Some(repo),
            None,
            key,
            "testDirectoryWrite",
            move |context| async move {
                let _directory = context
                    .directory_write_permit(&task_repo, vec![destination.clone()])
                    .await
                    .unwrap()
                    .unwrap();
                started.send(()).unwrap();
                released.await.unwrap();
                std::fs::create_dir(&destination).unwrap();
                std::fs::write(destination.join("completed.txt"), "done").unwrap();
                Ok::<Option<String>, TaskFailure>(None)
            },
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), ready)
        .await
        .unwrap()
        .unwrap();
    let mut claim = tokio::spawn(async move { access.claim(operation(&owner.repo_id)).await });
    assert!(tokio::time::timeout(Duration::from_millis(100), &mut claim)
        .await
        .is_err());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), claim)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(other.path().join("new-worktree/completed.txt")).unwrap(),
        "done"
    );
    let app = app_router(state, None);
    assert_eq!(
        wait_for_task(&app, &task.task_id).await["status"],
        "succeeded"
    );
}

#[tokio::test]
async fn cancelling_removal_waiting_for_an_alias_writer_preserves_the_directory() {
    let (source, state, repo, access) = fixture().await;
    seed(source.path());
    let external = tempfile::tempdir().unwrap();
    let linked = external.path().join("linked");
    git(
        source.path(),
        &[
            "worktree",
            "add",
            "--quiet",
            linked.to_str().unwrap(),
            "feature",
        ],
    );
    let alias = state
        .repositories
        .open_path(linked.to_str().unwrap())
        .await
        .unwrap();
    let writer = access.enter(&alias.repo_id).await.unwrap();
    let app = app_router(state.clone(), None);
    let task = submit(
        &app,
        &repo,
        "remove",
        serde_json::json!({"path":linked, "force":true}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if state.tasks.get(&task).await.unwrap().phase == "Waiting for worktree access" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    state.tasks.cancel(&task).await.unwrap();
    assert_eq!(wait_for_task(&app, &task).await["status"], "cancelled");
    assert!(linked.exists());
    drop(writer);
    tokio::time::timeout(Duration::from_secs(10), access.claim(operation(&repo)))
        .await
        .unwrap()
        .unwrap();
    assert!(linked.exists());
}
