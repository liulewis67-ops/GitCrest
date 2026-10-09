use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tokio::{sync::mpsc, time::Instant};

use crate::{
    features::{repositories::RepositoryManager, status::StatusService},
    EventBus,
};

const EVENT_QUEUE_CAPACITY: usize = 4096;
const MAX_DIRTY_PATHS: usize = 256;
const DEBOUNCE: Duration = Duration::from_millis(100);
const RECONCILE_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Clone)]
struct WatchInput {
    repo_id: String,
    scope: DirtyScope,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirtyScope {
    full: bool,
    paths: BTreeSet<String>,
    repository_updated: bool,
    refs_changed: bool,
    reasons: BTreeSet<String>,
}

impl DirtyScope {
    fn full(&mut self, reason: &str) {
        self.full = true;
        self.paths.clear();
        self.reasons.insert(reason.to_owned());
    }

    fn path(&mut self, path: String) {
        if !self.full {
            self.paths.insert(path);
            if self.paths.len() > MAX_DIRTY_PATHS {
                self.full("dirtyPathLimit");
            }
        }
        self.reasons.insert("workingTree".into());
    }

    fn merge(&mut self, other: Self) {
        self.repository_updated |= other.repository_updated;
        self.refs_changed |= other.refs_changed;
        self.reasons.extend(other.reasons);
        if other.full {
            self.full = true;
            self.paths.clear();
        } else if !self.full {
            self.paths.extend(other.paths);
            if self.paths.len() > MAX_DIRTY_PATHS {
                self.full("dirtyPathLimit");
            }
        }
    }

    fn is_empty(&self) -> bool {
        !self.full && self.paths.is_empty() && !self.repository_updated && !self.refs_changed
    }
}

struct WatchLocation {
    root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
}

struct Registration {
    _watcher: notify::RecommendedWatcher,
}

struct WatchFailure {
    retry_at: Instant,
    poll_at: Instant,
}

pub async fn run(repositories: RepositoryManager, status: StatusService, events: EventBus) {
    let (sender, mut receiver) = mpsc::channel::<WatchInput>(EVENT_QUEUE_CAPACITY);
    let overflowed = Arc::new(AtomicBool::new(false));
    let mut registrations = HashMap::<String, Registration>::new();
    let mut failures = HashMap::<String, WatchFailure>::new();
    let mut pending = HashMap::<String, DirtyScope>::new();
    let mut flush_at: Option<Instant> = None;
    let mut reconcile = tokio::time::interval(RECONCILE_INTERVAL);
    reconcile.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            biased;
            _ = async {
                if let Some(deadline) = flush_at { tokio::time::sleep_until(deadline).await; }
                else { std::future::pending::<()>().await; }
            } => {
                flush_at = None;
                publish_pending(&status, &events, &mut pending);
            }
            input = receiver.recv() => {
                if let Some(input) = input {
                    pending.entry(input.repo_id).or_default().merge(input.scope);
                    while let Ok(input) = receiver.try_recv() {
                        pending.entry(input.repo_id).or_default().merge(input.scope);
                    }
                    flush_at = Some(Instant::now() + DEBOUNCE);
                }
            }
            _ = reconcile.tick() => {
                let overflow = overflowed.swap(false, Ordering::AcqRel);
                if overflow {
                    for repo_id in registrations.keys() {
                        let scope = pending.entry(repo_id.clone()).or_default();
                        scope.full("watcherQueueOverflow");
                        scope.repository_updated = true;
                        scope.refs_changed = true;
                    }
                    flush_at = Some(Instant::now() + DEBOUNCE);
                }
                reconcile_repositories(
                    &repositories,
                    &status,
                    &sender,
                    &overflowed,
                    &mut registrations,
                    &mut failures,
                    &mut pending,
                ).await;
                if !pending.is_empty() && flush_at.is_none() {
                    flush_at = Some(Instant::now() + DEBOUNCE);
                }
            }
        }
    }
}

async fn reconcile_repositories(
    repositories: &RepositoryManager,
    status: &StatusService,
    sender: &mpsc::Sender<WatchInput>,
    overflowed: &Arc<AtomicBool>,
    registrations: &mut HashMap<String, Registration>,
    failures: &mut HashMap<String, WatchFailure>,
    pending: &mut HashMap<String, DirtyScope>,
) {
    let Ok(current) = repositories.list().await else {
        return;
    };
    let current_ids = current
        .iter()
        .filter(|repository| repository.availability == "available")
        .map(|repository| repository.repo_id.clone())
        .collect::<HashSet<_>>();
    registrations.retain(|repo_id, _| current_ids.contains(repo_id));
    failures.retain(|repo_id, _| current_ids.contains(repo_id));
    let now = Instant::now();
    for repository in current
        .into_iter()
        .filter(|repository| repository.availability == "available")
    {
        if registrations.contains_key(&repository.repo_id) {
            continue;
        }
        if let Some(failure) = failures.get_mut(&repository.repo_id) {
            if now >= failure.poll_at {
                let scope = pending.entry(repository.repo_id.clone()).or_default();
                scope.full("watcherPollingFallback");
                scope.repository_updated = true;
                failure.poll_at = now + Duration::from_secs(15);
            }
            if now < failure.retry_at {
                continue;
            }
        }
        match create_registration(
            &repository.repo_id,
            PathBuf::from(repository.path),
            status.clone(),
            sender,
            overflowed,
        )
        .await
        {
            Ok(registration) => {
                failures.remove(&repository.repo_id);
                registrations.insert(repository.repo_id.clone(), registration);
                let scope = pending.entry(repository.repo_id).or_default();
                scope.full("watcherAttached");
                scope.repository_updated = true;
                scope.refs_changed = true;
            }
            Err(()) => {
                failures
                    .entry(repository.repo_id.clone())
                    .and_modify(|failure| {
                        failure.retry_at = now + Duration::from_secs(30);
                        failure.poll_at = now + Duration::from_secs(15);
                    })
                    .or_insert(WatchFailure {
                        retry_at: now + Duration::from_secs(15),
                        poll_at: now + Duration::from_secs(5),
                    });
                let scope = pending.entry(repository.repo_id).or_default();
                scope.full("watcherUnavailable");
                scope.repository_updated = true;
            }
        }
    }
}

async fn create_registration(
    repo_id: &str,
    root: PathBuf,
    status: StatusService,
    sender: &mpsc::Sender<WatchInput>,
    overflowed: &Arc<AtomicBool>,
) -> Result<Registration, ()> {
    let root = tokio::fs::canonicalize(&root).await.map_err(|_| ())?;
    let git_dir = git_path(&root, "--git-dir").await?;
    let common_dir = git_path(&root, "--git-common-dir").await?;
    let git_dir = absolute_git_path(&root, git_dir);
    let common_dir = absolute_git_path(&root, common_dir);
    let callback_location = WatchLocation {
        root: root.clone(),
        git_dir: git_dir.clone(),
        common_dir: common_dir.clone(),
    };
    let repo_id = repo_id.to_owned();
    let sender = sender.clone();
    let status = status.clone();
    let overflowed = Arc::clone(overflowed);
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let scope = match result {
            Ok(event) => classify_event(&event, &callback_location),
            Err(_) => {
                let mut scope = DirtyScope::default();
                scope.full("watcherError");
                scope.repository_updated = true;
                scope.refs_changed = true;
                scope
            }
        };
        if scope.is_empty() {
            return;
        }
        let paths = scope.paths.iter().cloned().collect::<Vec<_>>();
        if scope.full || paths.is_empty() {
            status.invalidate(&repo_id);
        } else {
            status.invalidate_scope(&repo_id, &paths);
        }
        if sender
            .try_send(WatchInput {
                repo_id: repo_id.clone(),
                scope,
            })
            .is_err()
        {
            overflowed.store(true, Ordering::Release);
        }
    })
    .map_err(|_| ())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|_| ())?;
    if git_dir != common_dir && !git_dir.starts_with(&root) {
        watcher
            .watch(&git_dir, RecursiveMode::Recursive)
            .map_err(|_| ())?;
    }
    let mut metadata_roots = HashSet::new();
    metadata_roots.insert(common_dir.clone());
    for metadata_root in metadata_roots {
        if metadata_root.starts_with(&root) {
            continue;
        }
        watcher
            .watch(&metadata_root, RecursiveMode::NonRecursive)
            .map_err(|_| ())?;
        for child in ["refs", "worktrees", "rebase-merge", "rebase-apply"] {
            let path = metadata_root.join(child);
            if tokio::fs::metadata(&path).await.is_ok() {
                watcher
                    .watch(&path, RecursiveMode::Recursive)
                    .map_err(|_| ())?;
            }
        }
        let info = metadata_root.join("info");
        if tokio::fs::metadata(&info).await.is_ok() {
            watcher
                .watch(&info, RecursiveMode::NonRecursive)
                .map_err(|_| ())?;
        }
    }
    Ok(Registration { _watcher: watcher })
}

async fn git_path(root: &Path, argument: &str) -> Result<PathBuf, ()> {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", argument])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|_| ())?;
    if !output.status.success() {
        return Err(());
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

fn absolute_git_path(root: &Path, path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn classify_event(event: &Event, location: &WatchLocation) -> DirtyScope {
    if matches!(event.kind, EventKind::Access(_)) {
        return DirtyScope::default();
    }
    let named_change = matches!(
        event.kind,
        EventKind::Modify(notify::event::ModifyKind::Name(_))
    );
    if named_change {
        let mut scope = DirtyScope::default();
        for path in &event.paths {
            scope.merge(classify_path(path, location));
        }
        if scope.full || scope.repository_updated || scope.refs_changed {
            return scope;
        }
        scope.full("renameOrMultiPath");
        scope.repository_updated = true;
        scope.refs_changed = true;
        return scope;
    }
    if matches!(event.kind, EventKind::Other | EventKind::Any) || event.paths.len() != 1 {
        let mut scope = DirtyScope::default();
        scope.full(if event.paths.len() > 1 {
            "renameOrMultiPath"
        } else {
            "watcherRescan"
        });
        scope.repository_updated = true;
        scope.refs_changed = true;
        return scope;
    }
    classify_path(&event.paths[0], location)
}

fn classify_path(path: &Path, location: &WatchLocation) -> DirtyScope {
    let mut scope = DirtyScope::default();
    if let Some(relative) = path
        .strip_prefix(&location.git_dir)
        .ok()
        .or_else(|| path.strip_prefix(&location.common_dir).ok())
    {
        let relative = relative.to_string_lossy().replace('\\', "/");
        let normalized = relative.trim_start_matches('/');
        let lower = normalized.to_ascii_lowercase();
        if lower == "config" || lower == "config.worktree" || lower == "info/exclude" {
            scope.full(if lower == "info/exclude" {
                "excludeRules"
            } else {
                "gitConfig"
            });
            scope.repository_updated = true;
            return scope;
        }
        if lower == "head" {
            scope.full("headChanged");
            scope.repository_updated = true;
            scope.refs_changed = true;
            return scope;
        }
        if lower == "index" {
            scope.full("indexChanged");
            return scope;
        }
        if lower == "packed-refs" || lower.starts_with("refs/") || lower.starts_with("logs/refs/") {
            scope.refs_changed = true;
            scope.repository_updated = true;
            scope.reasons.insert("refsChanged".into());
            return scope;
        }
        if lower.contains("rebase-")
            || lower == "merge_head"
            || lower == "cherry_pick_head"
            || lower == "revert_head"
            || lower == "sequencer"
            || lower == "bisect_log"
        {
            scope.full("gitOperationState");
            scope.repository_updated = true;
            scope.refs_changed = true;
        }
        return scope;
    }
    let Ok(relative) = path.strip_prefix(&location.root) else {
        return scope;
    };
    let path_string = relative.to_string_lossy().replace('\\', "/");
    if path_string == ".git" {
        scope.full("gitDirectoryChanged");
        scope.repository_updated = true;
        scope.refs_changed = true;
    } else if relative
        .file_name()
        .is_some_and(|name| name == ".gitignore")
    {
        scope.full("ignoreRulesChanged");
    } else if !path_string.is_empty() {
        scope.path(path_string);
    }
    scope
}

fn publish_pending(
    status: &StatusService,
    events: &EventBus,
    pending: &mut HashMap<String, DirtyScope>,
) {
    for (repo_id, scope) in pending.drain() {
        let paths = scope.paths.iter().cloned().collect::<Vec<_>>();
        if scope.full || paths.is_empty() {
            status.invalidate(&repo_id);
        } else {
            status.invalidate_scope(&repo_id, &paths);
        }
        if scope.full || !scope.paths.is_empty() {
            events.publish(
                Some(repo_id.clone()),
                "status.changed",
                serde_json::to_value(&scope)
                    .unwrap_or_else(|_| serde_json::json!({ "full": true })),
            );
        }
        if scope.repository_updated {
            events.publish(
                Some(repo_id.clone()),
                "repository.updated",
                serde_json::json!({ "reasons": scope.reasons }),
            );
        }
        if scope.refs_changed {
            events.publish(
                Some(repo_id),
                "log.refsChanged",
                serde_json::json!({ "reasons": scope.reasons }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EventBus;
    use std::process::Command;

    fn location(root: &Path) -> WatchLocation {
        WatchLocation {
            root: root.to_path_buf(),
            git_dir: root.join(".git"),
            common_dir: root.join(".git"),
        }
    }

    #[test]
    fn coalesces_paths_and_upgrades_large_or_global_changes_to_full_refresh() {
        let mut scope = DirtyScope::default();
        scope.path("src/a.ts".into());
        scope.path("src/b.ts".into());
        let mut refs = DirtyScope {
            refs_changed: true,
            repository_updated: true,
            ..DirtyScope::default()
        };
        refs.reasons.insert("refsChanged".into());
        scope.merge(refs);
        assert_eq!(scope.paths.len(), 2);
        assert!(scope.refs_changed);

        let mut overflow = DirtyScope::default();
        for index in 0..=MAX_DIRTY_PATHS {
            overflow.path(format!("file-{index}.txt"));
        }
        assert!(overflow.full);
        assert!(overflow.paths.is_empty());
    }

    #[test]
    fn classifies_worktree_paths_and_git_metadata_into_scopes() {
        let root = PathBuf::from("C:/fixture");
        let location = location(&root);
        assert_eq!(
            classify_path(&root.join("src/a.ts"), &location).paths,
            BTreeSet::from(["src/a.ts".into()])
        );
        assert!(classify_path(&root.join(".gitignore"), &location).full);

        let head = classify_path(&root.join(".git/HEAD"), &location);
        assert!(head.full && head.repository_updated && head.refs_changed);
        assert!(classify_path(&root.join(".git/index"), &location).full);
        let refs = classify_path(&root.join(".git/refs/heads/main"), &location);
        assert!(refs.refs_changed && refs.repository_updated && !refs.full);
        assert!(classify_path(&root.join(".git/info/exclude"), &location).full);
    }

    #[test]
    fn upgrades_multi_path_rename_notifications_to_a_full_refresh() {
        let event = Event::new(EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::Both,
        )))
        .add_path(PathBuf::from("src/old.txt"))
        .add_path(PathBuf::from("src/new.txt"));
        let scope = classify_event(&event, &location(Path::new("/fixture")));
        assert!(scope.full);
        assert_eq!(scope.reasons, BTreeSet::from(["renameOrMultiPath".into()]));
    }

    #[tokio::test]
    async fn watches_external_worktree_edits_and_emits_a_mergeable_status_scope() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("watched-repo");
        std::fs::create_dir(&root).unwrap();
        let git = |arguments: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(arguments)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        git(&["config", "user.name", "Watcher Test"]);
        git(&["config", "user.email", "watcher@example.invalid"]);
        std::fs::write(root.join("tracked.txt"), "initial\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "--quiet", "-m", "initial"]);

        let repositories = RepositoryManager::default();
        let repository = repositories
            .open_path(root.to_str().unwrap())
            .await
            .unwrap();
        let status = StatusService::new(repositories.clone());
        let events = EventBus::default();
        let mut receiver = events.subscribe();
        let watcher = tokio::spawn(run(repositories.clone(), status.clone(), events));

        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.repo_id.as_deref() == Some(&repository.repo_id)
                    && event.event_type == "status.changed"
                    && event.payload["full"] == true
                {
                    break;
                }
            }
        })
        .await
        .expect("initial watcher registration should request a full snapshot");

        std::fs::write(root.join("tracked.txt"), "externally edited\n").unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.repo_id.as_deref() == Some(&repository.repo_id)
                    && event.event_type == "status.changed"
                    && event.payload["full"] == false
                    && event.payload["paths"]
                        .as_array()
                        .is_some_and(|paths| paths.iter().any(|path| path == "tracked.txt"))
                {
                    break;
                }
            }
        })
        .await
        .expect("external file edit should emit a path-scoped refresh");

        let partial = status
            .snapshot_paths(&repository.repo_id, &["tracked.txt".into()])
            .await
            .unwrap();
        assert_eq!(partial.files.len(), 1);
        assert_eq!(partial.files[0].path, "tracked.txt");

        git(&["add", "tracked.txt"]);
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.repo_id.as_deref() == Some(&repository.repo_id)
                    && event.event_type == "status.changed"
                    && event.payload["full"] == true
                    && event.payload["reasons"].as_array().is_some_and(|reasons| {
                        reasons.iter().any(|reason| reason == "indexChanged")
                    })
                {
                    break;
                }
            }
        })
        .await
        .expect("external index change should request a full snapshot");
        let indexed = status.snapshot(&repository.repo_id).await.unwrap();
        assert!(indexed.files[0]
            .categories
            .contains(&crate::features::status::ChangeCategory::Staged));

        std::fs::write(root.join(".gitignore"), "ignored.tmp\n").unwrap();
        std::fs::write(root.join("ignored.tmp"), "ignored\n").unwrap();
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.repo_id.as_deref() == Some(&repository.repo_id)
                    && event.event_type == "status.changed"
                    && event.payload["full"] == true
                    && event.payload["reasons"].as_array().is_some_and(|reasons| {
                        reasons.iter().any(|reason| reason == "ignoreRulesChanged")
                    })
                {
                    break;
                }
            }
        })
        .await
        .expect("ignore rule changes should request a full snapshot");

        git(&["config", "user.name", "Updated Watcher Test"]);
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.repo_id.as_deref() == Some(&repository.repo_id)
                    && event.event_type == "repository.updated"
                    && event.payload["reasons"]
                        .as_array()
                        .is_some_and(|reasons| reasons.iter().any(|reason| reason == "gitConfig"))
                {
                    break;
                }
            }
        })
        .await
        .expect("Git config changes should refresh repository metadata");

        git(&["commit", "--quiet", "-m", "external commit"]);
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.repo_id.as_deref() == Some(&repository.repo_id)
                    && event.event_type == "log.refsChanged"
                {
                    break;
                }
            }
        })
        .await
        .expect("external ref updates should refresh branch and history views");
        watcher.abort();
    }
}
