use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use super::{StatusFile, StatusSnapshot};

const MAX_CACHED_STATUS_REPOSITORIES: usize = 8;
const MAX_CACHED_STATUS_FILES: usize = 10_000;
const MAX_CACHED_STATUS_PATH_FILES: usize = 10_000;
const MAX_CACHED_STATUS_PATHS: usize = 256;

#[derive(Clone, Default)]
pub(crate) struct StatusSnapshotCache(Arc<Mutex<CacheState>>);

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, CacheEntry>,
    sequence: u64,
}

#[derive(Default)]
struct CacheEntry {
    version: u64,
    last_used: u64,
    full_snapshot: Option<StatusSnapshot>,
    path_snapshots: HashMap<String, CachedPathStatus>,
    dirty_paths: HashSet<String>,
}

struct CachedPathStatus {
    files: Vec<StatusFile>,
    refreshed_at_ms: i64,
}

impl StatusSnapshotCache {
    pub(crate) fn invalidate(&self, repo_id: &str, full: bool, paths: &[String]) {
        let mut cache = self.0.lock().unwrap_or_else(|error| error.into_inner());
        ensure_entry(&mut cache, repo_id);
        if let Some(entry) = cache.entries.get_mut(repo_id) {
            entry.version = entry.version.wrapping_add(1);
            if full
                || paths.is_empty()
                || entry.dirty_paths.len().saturating_add(paths.len()) > MAX_CACHED_STATUS_PATHS
            {
                entry.full_snapshot = None;
                entry.path_snapshots.clear();
                entry.dirty_paths.clear();
            } else {
                for path in paths {
                    entry.dirty_paths.insert(path.clone());
                    entry
                        .path_snapshots
                        .retain(|cached_path, _| !scopes_overlap(cached_path, path));
                }
            }
        }
    }

    pub(crate) fn version(&self, repo_id: &str) -> u64 {
        let mut cache = self.0.lock().unwrap_or_else(|error| error.into_inner());
        ensure_entry(&mut cache, repo_id);
        cache.entries.get(repo_id).map_or(0, |entry| entry.version)
    }

    pub(crate) fn full(&self, repo_id: &str) -> Option<StatusSnapshot> {
        let mut cache = self.0.lock().unwrap_or_else(|error| error.into_inner());
        touch(&mut cache, repo_id);
        let entry = cache.entries.get(repo_id)?;
        if entry.dirty_paths.is_empty() {
            entry.full_snapshot.clone()
        } else {
            None
        }
    }

    pub(crate) fn paths(&self, repo_id: &str, paths: &[String]) -> Option<StatusSnapshot> {
        let mut cache = self.0.lock().unwrap_or_else(|error| error.into_inner());
        touch(&mut cache, repo_id);
        let entry = cache.entries.get(repo_id)?;
        if paths.iter().any(|path| {
            entry
                .dirty_paths
                .iter()
                .any(|dirty_path| scopes_overlap(path, dirty_path))
        }) {
            return None;
        }
        if let Some(full_snapshot) = &entry.full_snapshot {
            let files = full_snapshot
                .files
                .iter()
                .filter(|file| paths.iter().any(|path| file_matches_scope(file, path)))
                .cloned()
                .collect();
            return Some(StatusSnapshot {
                repo_id: repo_id.to_owned(),
                refreshed_at_ms: full_snapshot.refreshed_at_ms,
                files,
            });
        }
        let mut files = Vec::new();
        let mut refreshed_at_ms = 0;
        for path in paths {
            let cached = entry.path_snapshots.get(path)?;
            refreshed_at_ms = refreshed_at_ms.max(cached.refreshed_at_ms);
            for file in &cached.files {
                if !files.contains(file) {
                    files.push(file.clone());
                }
            }
        }
        Some(StatusSnapshot {
            repo_id: repo_id.to_owned(),
            refreshed_at_ms,
            files,
        })
    }

    pub(crate) fn store_full(&self, repo_id: &str, version: u64, snapshot: &StatusSnapshot) {
        let mut cache = self.0.lock().unwrap_or_else(|error| error.into_inner());
        ensure_entry(&mut cache, repo_id);
        if let Some(entry) = cache.entries.get_mut(repo_id) {
            if entry.version == version {
                entry.full_snapshot =
                    (snapshot.files.len() <= MAX_CACHED_STATUS_FILES).then(|| snapshot.clone());
                entry.path_snapshots.clear();
                entry.dirty_paths.clear();
            }
        }
    }

    pub(crate) fn store_paths(
        &self,
        repo_id: &str,
        version: u64,
        paths: &[String],
        snapshot: &StatusSnapshot,
    ) {
        let mut cache = self.0.lock().unwrap_or_else(|error| error.into_inner());
        ensure_entry(&mut cache, repo_id);
        let Some(entry) = cache.entries.get_mut(repo_id) else {
            return;
        };
        if entry.version != version {
            return;
        }
        for path in paths {
            let files = snapshot
                .files
                .iter()
                .filter(|file| file_matches_scope(file, path))
                .cloned()
                .collect();
            entry.path_snapshots.insert(
                path.clone(),
                CachedPathStatus {
                    files,
                    refreshed_at_ms: snapshot.refreshed_at_ms,
                },
            );
        }
        if let Some(full_snapshot) = entry.full_snapshot.as_mut() {
            full_snapshot
                .files
                .retain(|file| !paths.iter().any(|path| file_matches_scope(file, path)));
            for file in &snapshot.files {
                if !full_snapshot.files.contains(file) {
                    full_snapshot.files.push(file.clone());
                }
            }
            full_snapshot
                .files
                .sort_by(|left, right| left.path.cmp(&right.path));
            full_snapshot.refreshed_at_ms = snapshot.refreshed_at_ms;
        }
        entry
            .dirty_paths
            .retain(|dirty_path| !paths.iter().any(|path| scopes_overlap(dirty_path, path)));
        while entry.path_snapshots.len() > MAX_CACHED_STATUS_PATHS
            || entry
                .path_snapshots
                .values()
                .map(|cached| cached.files.len())
                .sum::<usize>()
                > MAX_CACHED_STATUS_PATH_FILES
        {
            let Some(oldest) = entry.path_snapshots.keys().next().cloned() else {
                break;
            };
            entry.path_snapshots.remove(&oldest);
        }
    }
}

fn touch(cache: &mut CacheState, repo_id: &str) {
    cache.sequence = cache.sequence.wrapping_add(1);
    let sequence = cache.sequence;
    if let Some(entry) = cache.entries.get_mut(repo_id) {
        entry.last_used = sequence;
    }
}

fn ensure_entry(cache: &mut CacheState, repo_id: &str) {
    if !cache.entries.contains_key(repo_id) && cache.entries.len() >= MAX_CACHED_STATUS_REPOSITORIES
    {
        if let Some(oldest) = cache
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(id, _)| id.clone())
        {
            cache.entries.remove(&oldest);
        }
    }
    cache.sequence = cache.sequence.wrapping_add(1);
    let sequence = cache.sequence;
    let entry = cache
        .entries
        .entry(repo_id.to_owned())
        .or_insert_with(|| CacheEntry {
            version: sequence,
            last_used: sequence,
            ..CacheEntry::default()
        });
    entry.last_used = sequence;
}

fn normalize_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = path.trim_end_matches('/');
    let path = path.strip_prefix("./").unwrap_or(path);
    if path == "." {
        String::new()
    } else {
        path.to_owned()
    }
}

fn path_matches_scope(path: &str, scope: &str) -> bool {
    let path = normalize_path(path);
    let scope = normalize_path(scope);
    scope.is_empty()
        || path == scope
        || path
            .strip_prefix(&scope)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn scopes_overlap(left: &str, right: &str) -> bool {
    path_matches_scope(left, right) || path_matches_scope(right, left)
}

fn file_matches_scope(file: &StatusFile, scope: &str) -> bool {
    path_matches_scope(&file.path, scope)
        || file
            .original_path
            .as_deref()
            .is_some_and(|path| path_matches_scope(path, scope))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::status::{ChangeCategory, ChangeKind};

    fn file(path: &str, kind: ChangeKind) -> StatusFile {
        StatusFile {
            path: path.to_owned(),
            original_path: None,
            index_status: ".".into(),
            worktree_status: "M".into(),
            kind,
            categories: vec![ChangeCategory::Unstaged],
            mode_changed: false,
        }
    }

    fn snapshot(repo_id: &str, refreshed_at_ms: i64, files: Vec<StatusFile>) -> StatusSnapshot {
        StatusSnapshot {
            repo_id: repo_id.to_owned(),
            refreshed_at_ms,
            files,
        }
    }

    #[test]
    fn path_invalidation_keeps_unaffected_full_status_and_merges_refreshed_scope() {
        let cache = StatusSnapshotCache::default();
        let repo_id = "repo_scope_cache";
        let version = cache.version(repo_id);
        let before = snapshot(
            repo_id,
            10,
            vec![
                file("src/changed.rs", ChangeKind::Modified),
                file("src/kept.rs", ChangeKind::Modified),
                file("README.md", ChangeKind::Modified),
            ],
        );
        cache.store_full(repo_id, version, &before);

        cache.invalidate(repo_id, false, &["src/changed.rs".into()]);
        assert!(cache.full(repo_id).is_none());
        let unaffected = cache.paths(repo_id, &["README.md".into()]).unwrap();
        assert_eq!(unaffected.files, [before.files[2].clone()]);

        let refresh_version = cache.version(repo_id);
        let changed = snapshot(repo_id, 20, vec![file("src/changed.rs", ChangeKind::Added)]);
        cache.store_paths(
            repo_id,
            refresh_version,
            &["src/changed.rs".into()],
            &changed,
        );

        let merged = cache.full(repo_id).unwrap();
        assert_eq!(merged.refreshed_at_ms, 20);
        assert_eq!(merged.files.len(), 3);
        assert!(merged
            .files
            .iter()
            .any(|file| { file.path == "src/changed.rs" && file.kind == ChangeKind::Added }));
        let directory_scope = cache.paths(repo_id, &["src".into()]).unwrap();
        assert_eq!(directory_scope.files.len(), 2);
    }

    #[test]
    fn stale_dirty_scope_refresh_cannot_clear_a_newer_invalidation() {
        let cache = StatusSnapshotCache::default();
        let repo_id = "repo_stale_scope_cache";
        let initial_version = cache.version(repo_id);
        cache.store_full(
            repo_id,
            initial_version,
            &snapshot(repo_id, 10, vec![file("src/file.rs", ChangeKind::Modified)]),
        );
        cache.invalidate(repo_id, false, &["src/file.rs".into()]);
        let stale_refresh = snapshot(repo_id, 15, vec![file("src/file.rs", ChangeKind::Added)]);
        cache.store_paths(
            repo_id,
            initial_version,
            &["src/file.rs".into()],
            &stale_refresh,
        );
        assert!(cache.full(repo_id).is_none());
        assert!(cache.paths(repo_id, &["src/file.rs".into()]).is_none());
    }

    #[test]
    fn status_scopes_match_directories_and_root_without_crossing_sibling_names() {
        let nested = file("src/lib/file.rs", ChangeKind::Modified);
        assert!(file_matches_scope(&nested, "src"));
        assert!(file_matches_scope(&nested, "./src/"));
        assert!(file_matches_scope(&nested, "."));
        assert!(!file_matches_scope(&nested, "src/liber"));
    }

    #[test]
    fn excessive_dirty_paths_promote_to_full_invalidation() {
        let cache = StatusSnapshotCache::default();
        let repo_id = "repo_dirty_scope_limit";
        let version = cache.version(repo_id);
        cache.store_full(
            repo_id,
            version,
            &snapshot(repo_id, 10, vec![file("tracked.txt", ChangeKind::Modified)]),
        );
        let paths = (0..=MAX_CACHED_STATUS_PATHS)
            .map(|index| format!("file-{index}.txt"))
            .collect::<Vec<_>>();

        cache.invalidate(repo_id, false, &paths);

        assert!(cache.full(repo_id).is_none());
        assert!(cache.paths(repo_id, &["tracked.txt".into()]).is_none());
    }
}
