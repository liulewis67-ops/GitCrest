use super::write_access_api_tests::{fixture as parent_fixture, operation};
use super::*;
use crate::{domain::task::TaskStatus, execution::write_access::WriteAccess};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn git(path: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args([
            "-c",
            "protocol.file.allow=always",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "submodule.recurse=false",
            "-c",
            "user.name=Scope Test",
            "-c",
            "user.email=scope@example.invalid",
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
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn seed(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    git(path, &["init", "--quiet"]);
    std::fs::write(path.join("seed.txt"), "base\n").unwrap();
    git(path, &["add", "."]);
    git(path, &["commit", "--quiet", "-m", "seed"]);
}

struct Fixture {
    _sources: tempfile::TempDir,
    parent: tempfile::TempDir,
    state: AppState,
    parent_id: String,
    access: WriteAccess,
    grand_source: PathBuf,
    module: PathBuf,
    nested: PathBuf,
    sibling: PathBuf,
    target_module: String,
    target_nested: String,
}

async fn fixture() -> Fixture {
    let (parent, state, parent_id, access) = parent_fixture().await;
    let sources = tempfile::tempdir().unwrap();
    let grand = sources.path().join("grand");
    seed(&grand);
    let child = sources.path().join("child");
    seed(&child);
    git(
        &child,
        &[
            "submodule",
            "add",
            "--quiet",
            "--name",
            "nested/id",
            grand.to_str().unwrap(),
            "nested/inner",
        ],
    );
    git(&child, &["commit", "--quiet", "-am", "nested"]);
    let initial_child = git(&child, &["rev-parse", "HEAD"]);
    git(
        parent.path(),
        &[
            "submodule",
            "add",
            "--quiet",
            "--name",
            "module-alias",
            child.to_str().unwrap(),
            "deps/module space",
        ],
    );
    git(
        parent.path(),
        &[
            "submodule",
            "add",
            "--quiet",
            "--name",
            "sibling",
            grand.to_str().unwrap(),
            "deps/sibling",
        ],
    );
    git(
        parent.path(),
        &["submodule", "update", "--init", "--recursive"],
    );
    git(parent.path(), &["commit", "--quiet", "-am", "modules"]);
    let module = parent.path().join("deps/module space");
    let nested = module.join("nested/inner");
    let sibling = parent.path().join("deps/sibling");
    std::fs::write(grand.join("seed.txt"), "incoming\n").unwrap();
    git(&grand, &["commit", "--quiet", "-am", "incoming"]);
    let target_nested = git(&grand, &["rev-parse", "HEAD"]);
    let source_nested = child.join("nested/inner");
    git(&source_nested, &["fetch", "--quiet", "origin"]);
    git(&source_nested, &["checkout", "--quiet", &target_nested]);
    git(&child, &["commit", "--quiet", "-am", "advance nested"]);
    // Make the object available without changing this checkout. Product tests
    // need no relaxation of Git's local-file transport policy.
    git(&nested, &["fetch", "--quiet", "origin"]);
    let target_module = git(&child, &["rev-parse", "HEAD"]);
    git(&module, &["fetch", "--quiet", "origin"]);
    git(&module, &["checkout", "--quiet", &target_module]);
    git(parent.path(), &["add", "deps/module space"]);
    git(
        parent.path(),
        &["commit", "--quiet", "-m", "advance module"],
    );
    git(&module, &["checkout", "--quiet", &initial_child]);
    Fixture {
        _sources: sources,
        parent,
        state,
        parent_id,
        access,
        grand_source: grand,
        module,
        nested,
        sibling,
        target_module,
        target_nested,
    }
}

async fn update(fixture: &Fixture) -> crate::domain::task::TaskSnapshot {
    let response = app_router(fixture.state.clone(), None)
        .oneshot(json_request(
            Method::POST,
            &format!(
                "/api/v1/repositories/{}/submodules/update",
                fixture.parent_id
            ),
            r#"{"paths":["deps/module space"],"init":true}"#,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let task = json_body(response).await;
    let id = task["taskId"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let task = fixture.state.tasks.get(id).await.unwrap();
            if task.status.is_terminal() {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn a_nested_owner_prevents_recursive_update_without_changing_local_files() {
    let fixture = fixture().await;
    let nested = fixture
        .state
        .repositories
        .open_path(fixture.nested.to_str().unwrap())
        .await
        .unwrap();
    fixture
        .access
        .claim(operation(&nested.repo_id))
        .await
        .unwrap();
    let before = git(&fixture.nested, &["rev-parse", "HEAD"]);
    std::fs::write(fixture.nested.join("local-note.txt"), "keep\n").unwrap();
    let task = update(&fixture).await;
    assert_eq!(task.status, TaskStatus::Failed);
    assert_eq!(
        task.failure_code,
        Some(crate::domain::git_result::GitFailureCode::PreconditionChanged)
    );
    assert!(task.message.unwrap().contains("owned-operation"));
    assert_eq!(git(&fixture.nested, &["rev-parse", "HEAD"]), before);
    assert_eq!(
        std::fs::read_to_string(fixture.nested.join("local-note.txt")).unwrap(),
        "keep\n"
    );
}

#[tokio::test]
async fn an_owner_in_an_unselected_sibling_does_not_block_the_requested_update() {
    let fixture = fixture().await;
    let sibling = fixture
        .state
        .repositories
        .open_path(fixture.sibling.to_str().unwrap())
        .await
        .unwrap();
    fixture
        .access
        .claim(operation(&sibling.repo_id))
        .await
        .unwrap();
    let task = update(&fixture).await;
    assert_eq!(task.status, TaskStatus::Succeeded, "{:?}", task.message);
    assert_eq!(
        git(&fixture.module, &["rev-parse", "HEAD"]),
        fixture.target_module
    );
    assert_eq!(
        git(&fixture.nested, &["rev-parse", "HEAD"]),
        fixture.target_nested
    );
}

#[tokio::test]
async fn an_external_common_directory_is_protected_through_its_worktree_inside_the_update() {
    let fixture = fixture().await;
    let alias = fixture.module.join("undeclared linked tree");
    git(
        &fixture.grand_source,
        &[
            "worktree",
            "add",
            "--quiet",
            "--detach",
            alias.to_str().unwrap(),
            "HEAD",
        ],
    );
    let external = fixture
        .state
        .repositories
        .open_path(fixture.grand_source.to_str().unwrap())
        .await
        .unwrap();
    fixture
        .access
        .claim(operation(&external.repo_id))
        .await
        .unwrap();
    let task = update(&fixture).await;
    assert_eq!(task.status, TaskStatus::Failed);
    assert!(task.message.unwrap().contains("owned-operation"));
    assert_ne!(
        git(&fixture.module, &["rev-parse", "HEAD"]),
        fixture.target_module
    );
}

#[tokio::test]
async fn a_recursive_update_reservation_blocks_new_child_owner_claims() {
    let fixture = fixture().await;
    let nested = fixture
        .state
        .repositories
        .open_path(fixture.nested.to_str().unwrap())
        .await
        .unwrap();
    let trees = crate::features::submodules::update_write_trees(
        fixture.parent.path(),
        &["deps/module space".into()],
    )
    .await
    .unwrap();
    let lease = fixture
        .access
        .submodule_update(&fixture.parent_id, trees)
        .await
        .unwrap();
    let target = fixture
        .state
        .repository_targets
        .task_target(&nested.repo_id)
        .await
        .unwrap();
    let queued = tokio::time::timeout(
        Duration::from_secs(3),
        fixture.state.tasks.submit(
            Some(nested.repo_id.clone()),
            None,
            target.resource_key,
            "write",
            |_| async {
                panic!("a queued child write must not execute under a recursive reservation");
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    fixture.state.tasks.cancel(&queued.task_id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let task = fixture.state.tasks.get(&queued.task_id).await.unwrap();
            if task.status.is_terminal() {
                assert_eq!(task.status, TaskStatus::Cancelled);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let access = fixture.access.clone();
    let mut claim = tokio::spawn(async move { access.claim(operation(&nested.repo_id)).await });
    assert!(tokio::time::timeout(Duration::from_millis(100), &mut claim)
        .await
        .is_err());
    drop(lease);
    tokio::time::timeout(Duration::from_secs(10), claim)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn a_reservation_covers_a_submodule_initialized_after_discovery() {
    let fixture = fixture().await;
    git(
        fixture.parent.path(),
        &["submodule", "deinit", "--force", "deps/module space"],
    );
    let trees = crate::features::submodules::update_write_trees(
        fixture.parent.path(),
        &["deps/module space".into()],
    )
    .await
    .unwrap();
    let lease = fixture
        .access
        .submodule_update(&fixture.parent_id, trees)
        .await
        .unwrap();
    git(
        fixture.parent.path(),
        &[
            "submodule",
            "update",
            "--init",
            "--recursive",
            "--",
            "deps/module space",
        ],
    );
    let child = fixture
        .state
        .repositories
        .open_path(fixture.module.to_str().unwrap())
        .await
        .unwrap();
    let access = fixture.access.clone();
    let mut claim = tokio::spawn(async move { access.claim(operation(&child.repo_id)).await });
    assert!(tokio::time::timeout(Duration::from_millis(100), &mut claim)
        .await
        .is_err());
    drop(lease);
    tokio::time::timeout(Duration::from_secs(10), claim)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn cancelling_an_update_waiting_for_a_child_write_does_not_run_git() {
    let fixture = fixture().await;
    let child = fixture
        .state
        .repositories
        .open_path(fixture.nested.to_str().unwrap())
        .await
        .unwrap();
    let existing_write = fixture.access.enter(&child.repo_id).await.unwrap();
    let response = app_router(fixture.state.clone(), None)
        .oneshot(json_request(
            Method::POST,
            &format!(
                "/api/v1/repositories/{}/submodules/update",
                fixture.parent_id
            ),
            r#"{"paths":["deps/module space"],"init":true}"#,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body = json_body(response).await;
    let id = body["taskId"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if fixture.state.tasks.get(id).await.unwrap().phase == "Waiting for submodule access" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    fixture.state.tasks.cancel(id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let task = fixture.state.tasks.get(id).await.unwrap();
            if task.status.is_terminal() {
                assert_eq!(task.status, TaskStatus::Cancelled);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_ne!(
        git(&fixture.module, &["rev-parse", "HEAD"]),
        fixture.target_module
    );
    drop(existing_write);
    tokio::time::timeout(
        Duration::from_secs(5),
        fixture.access.claim(operation(&child.repo_id)),
    )
    .await
    .unwrap()
    .unwrap();
}
