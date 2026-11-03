use super::*;

fn git(path: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

struct Fixture {
    _directory: tempfile::TempDir,
    root: std::path::PathBuf,
    writer: std::path::PathBuf,
    remote: std::path::PathBuf,
    app: Router,
    repo_id: String,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        let remote = directory.path().join("remote.git");
        let writer = directory.path().join("writer");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "user.email", "test@example.invalid"]);
        git(&root, &["commit", "--allow-empty", "-m", "seed"]);
        git(&root, &["init", "--bare", remote.to_str().unwrap()]);
        git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        for branch in ["alpha", "beta", "occupied"] {
            git(&root, &["branch", branch]);
        }
        git(
            &root,
            &["push", "-u", "origin", "main", "alpha", "beta", "occupied"],
        );
        git(
            &root,
            &[
                "clone",
                "--branch",
                "main",
                remote.to_str().unwrap(),
                writer.to_str().unwrap(),
            ],
        );
        git(&writer, &["config", "user.name", "Writer"]);
        git(&writer, &["config", "user.email", "writer@example.invalid"]);
        let app = test_app(None);
        let response = app
            .clone()
            .oneshot(json_request(
                Method::POST,
                "/api/v1/repositories",
                &serde_json::json!({"path": root}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        Self {
            _directory: directory,
            root,
            writer,
            remote,
            app,
            repo_id: body["repoId"].as_str().unwrap().into(),
        }
    }

    async fn sync(&self, branch: &str, operation: &str, oid: &str) -> serde_json::Value {
        let response = self
            .app
            .clone()
            .oneshot(json_request(
                Method::POST,
                &format!("/api/v1/repositories/{}/branches/sync", self.repo_id),
                &serde_json::json!({"name": branch, "operation": operation, "expectedOid": oid})
                    .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let accepted: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        wait_for_task(&self.app, accepted["taskId"].as_str().unwrap()).await
    }

    fn advance_remote(&self, branch: &str) {
        git(
            &self.writer,
            &["commit", "--allow-empty", "-m", "remote advance"],
        );
        git(&self.writer, &["push", "origin", &format!("HEAD:{branch}")]);
    }
}

#[tokio::test]
async fn branch_sync_fast_forwards_noncurrent_without_switching_or_touching_edits() {
    let fixture = Fixture::new().await;
    let head = git(&fixture.root, &["rev-parse", "HEAD"]);
    fixture.advance_remote("alpha");
    std::fs::write(fixture.root.join("local.txt"), "keep me").unwrap();
    let task = fixture.sync("alpha", "pull", &head).await;
    assert_eq!(task["status"], "succeeded", "{task}");
    assert_eq!(git(&fixture.root, &["branch", "--show-current"]), "main");
    assert_eq!(git(&fixture.root, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        git(&fixture.root, &["rev-parse", "alpha"]),
        git(&fixture.writer, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("local.txt")).unwrap(),
        "keep me"
    );
    fixture.advance_remote("main");
    let task = fixture.sync("main", "pull", &head).await;
    assert_eq!(task["status"], "failed", "{task}");
    std::fs::remove_file(fixture.root.join("local.txt")).unwrap();
    let task = fixture.sync("main", "pull", &head).await;
    assert_eq!(task["status"], "succeeded", "{task}");
}

#[tokio::test]
async fn branch_sync_rejects_divergence_occupancy_and_stale_selection() {
    let fixture = Fixture::new().await;
    let original = git(&fixture.root, &["rev-parse", "HEAD"]);
    git(&fixture.root, &["switch", "alpha"]);
    git(
        &fixture.root,
        &["commit", "--allow-empty", "-m", "local advance"],
    );
    let local = git(&fixture.root, &["rev-parse", "HEAD"]);
    git(&fixture.root, &["switch", "main"]);
    fixture.advance_remote("alpha");
    for operation in ["pull", "push"] {
        let task = fixture.sync("alpha", operation, &local).await;
        assert_eq!(task["status"], "failed", "{task}");
        assert_eq!(git(&fixture.root, &["rev-parse", "alpha"]), local);
    }
    let linked = fixture._directory.path().join("linked");
    git(
        &fixture.root,
        &["worktree", "add", linked.to_str().unwrap(), "occupied"],
    );
    fixture.advance_remote("occupied");
    let task = fixture.sync("occupied", "pull", &original).await;
    assert_eq!(task["status"], "failed", "{task}");
    assert_eq!(git(&linked, &["rev-parse", "HEAD"]), original);
    let task = fixture.sync("beta", "push", &"b".repeat(40)).await;
    assert_eq!(task["status"], "failed", "{task}");
    assert_eq!(git(&fixture.root, &["branch", "--show-current"]), "main");
}

#[tokio::test]
async fn branch_sync_pushes_explicit_branches_and_requires_write_capability() {
    let fixture = Fixture::new().await;
    for branch in ["alpha", "beta"] {
        git(&fixture.root, &["switch", branch]);
        git(&fixture.root, &["commit", "--allow-empty", "-m", branch]);
    }
    git(&fixture.root, &["switch", "main"]);
    for branch in ["alpha", "beta"] {
        let oid = git(&fixture.root, &["rev-parse", branch]);
        let task = fixture.sync(branch, "push", &oid).await;
        assert_eq!(task["status"], "succeeded", "{task}");
        assert_eq!(git(&fixture.remote, &["rev-parse", branch]), oid);
    }
    let denied = fixture
        .app
        .clone()
        .oneshot(json_request_with_token(
            Method::POST,
            &format!("/api/v1/repositories/{}/branches/sync", fixture.repo_id),
            &serde_json::json!({"name":"main", "operation":"push", "expectedOid": "a".repeat(40)})
                .to_string(),
            READ_ONLY_TOKEN,
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(git(&fixture.root, &["branch", "--show-current"]), "main");
}
