use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::{
    domain::{error::RepositoryError, repository::RepositoryRecord},
    ports::repository::RepositoryCatalogPort,
};

/// Pipeline worktrees that behave like repository contexts (own RepoId, own
/// resource key) without ever being saved to the repository list.
#[derive(Default)]
pub(crate) struct EphemeralContexts {
    contexts: Mutex<HashMap<String, PathBuf>>,
}

impl EphemeralContexts {
    pub(crate) fn register(&self, repo_id: &str, path: &Path) {
        if let Ok(mut contexts) = self.contexts.lock() {
            contexts.insert(repo_id.to_owned(), path.to_path_buf());
        }
    }

    pub(crate) fn unregister(&self, repo_id: &str) {
        if let Ok(mut contexts) = self.contexts.lock() {
            contexts.remove(repo_id);
        }
    }

    pub(crate) fn path(&self, repo_id: &str) -> Option<PathBuf> {
        self.contexts.lock().ok()?.get(repo_id).cloned()
    }

    /// Tasks on a pipeline worktree lock the worktree itself, never the main
    /// repository that owns its Git directory.
    pub(crate) fn resource_key(&self, repo_id: &str) -> Option<String> {
        self.path(repo_id)
            .map(|path| format!("pipeline-worktree:{}", path.to_string_lossy()))
    }

    fn record(&self, repo_id: &str) -> Option<RepositoryRecord> {
        self.path(repo_id).map(|path| RepositoryRecord {
            repo_id: repo_id.to_owned(),
            path: path.to_string_lossy().into_owned(),
            head: None,
            branch: None,
            detached: true,
            state: "normal".into(),
            is_favorite: false,
            last_accessed_at: 0,
            availability: "available".into(),
        })
    }
}

/// Catalog decorator: resolves ephemeral contexts first, and keeps them out of
/// the repository list, recents and every write.
pub(crate) struct EphemeralAwareCatalog {
    inner: Arc<dyn RepositoryCatalogPort>,
    contexts: Arc<EphemeralContexts>,
}

impl EphemeralAwareCatalog {
    pub(crate) fn new(
        inner: Arc<dyn RepositoryCatalogPort>,
        contexts: Arc<EphemeralContexts>,
    ) -> Self {
        Self { inner, contexts }
    }
}

impl RepositoryCatalogPort for EphemeralAwareCatalog {
    fn save_opened(
        &self,
        repository: RepositoryRecord,
    ) -> Result<RepositoryRecord, RepositoryError> {
        self.inner.save_opened(repository)
    }

    fn mark_opened(
        &self,
        repo_id: &str,
        last_accessed_at: i64,
    ) -> Result<Option<RepositoryRecord>, RepositoryError> {
        if let Some(record) = self.contexts.record(repo_id) {
            return Ok(Some(record));
        }
        self.inner.mark_opened(repo_id, last_accessed_at)
    }

    fn get(&self, repo_id: &str) -> Result<Option<RepositoryRecord>, RepositoryError> {
        if let Some(record) = self.contexts.record(repo_id) {
            return Ok(Some(record));
        }
        self.inner.get(repo_id)
    }

    fn list(&self) -> Result<Vec<RepositoryRecord>, RepositoryError> {
        self.inner.list()
    }

    fn set_favorite(
        &self,
        repo_id: &str,
        favorite: bool,
    ) -> Result<Option<RepositoryRecord>, RepositoryError> {
        if self.contexts.path(repo_id).is_some() {
            return Ok(None);
        }
        self.inner.set_favorite(repo_id, favorite)
    }

    fn forget(&self, repo_id: &str) -> Result<bool, RepositoryError> {
        if self.contexts.path(repo_id).is_some() {
            return Ok(false);
        }
        self.inner.forget(repo_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::RepositoryStore;

    fn catalog() -> (EphemeralAwareCatalog, Arc<EphemeralContexts>) {
        let store = RepositoryStore::default();
        store.insert_test_repository("main");
        let contexts = Arc::new(EphemeralContexts::default());
        (
            EphemeralAwareCatalog::new(Arc::new(store), contexts.clone()),
            contexts,
        )
    }

    #[test]
    fn registered_contexts_resolve_but_stay_out_of_the_list() {
        let (catalog, contexts) = catalog();
        assert!(catalog.get("eph").unwrap().is_none());

        contexts.register("eph", Path::new("/data/pipelines/run/uat"));
        let record = catalog.get("eph").unwrap().unwrap();
        assert_eq!(record.path, "/data/pipelines/run/uat");
        assert!(catalog.mark_opened("eph", 5).unwrap().is_some());
        let listed: Vec<_> = catalog
            .list()
            .unwrap()
            .into_iter()
            .map(|r| r.repo_id)
            .collect();
        assert_eq!(listed, ["main"]);
        assert!(catalog.get("main").unwrap().is_some());

        contexts.unregister("eph");
        assert!(catalog.get("eph").unwrap().is_none());
    }

    #[test]
    fn ephemeral_contexts_ignore_favorite_and_forget_writes() {
        let (catalog, contexts) = catalog();
        contexts.register("eph", Path::new("/data/pipelines/run/uat"));
        assert!(catalog.set_favorite("eph", true).unwrap().is_none());
        assert!(!catalog.forget("eph").unwrap());
        assert!(catalog.get("eph").unwrap().is_some());
    }

    #[test]
    fn ephemeral_resource_keys_differ_from_the_main_repository() {
        let contexts = EphemeralContexts::default();
        assert_eq!(contexts.resource_key("eph"), None);
        contexts.register("eph", Path::new("/data/pipelines/run/uat"));
        contexts.register("eph2", Path::new("/data/pipelines/run/dev"));
        assert_ne!(contexts.resource_key("eph"), contexts.resource_key("eph2"));
        assert!(contexts
            .resource_key("eph")
            .unwrap()
            .starts_with("pipeline-worktree:"));
    }
}

#[cfg(test)]
mod target_tests {
    use super::*;
    use crate::{
        features::{
            pipelines::worktree_tests::{fixture, git},
            repositories::RepositoryTargetReader,
        },
        git::repository::GitRepositoryAdapter,
        storage::{repository_paths::RepositoryFilesystemAdapter, RepositoryStore},
    };

    #[tokio::test]
    async fn task_targets_of_a_pipeline_context_use_the_worktree_and_their_own_lock() {
        let fixture = fixture();
        let worktree = fixture.data_dir.join("pipelines/run/0");
        std::fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        git(
            &fixture.repository,
            &[
                "worktree",
                "add",
                "--detach",
                worktree.to_str().unwrap(),
                "HEAD",
            ],
        );

        let store = RepositoryStore::default();
        store.insert_test_repository_at("main", &fixture.repository);
        let contexts = Arc::new(EphemeralContexts::default());
        contexts.register("pipeline-run-0", &worktree);
        let catalog: Arc<dyn RepositoryCatalogPort> = Arc::new(EphemeralAwareCatalog::new(
            Arc::new(store),
            contexts.clone(),
        ));
        let reader = RepositoryTargetReader::new(
            catalog,
            Arc::new(GitRepositoryAdapter),
            Arc::new(RepositoryFilesystemAdapter),
        )
        .with_ephemeral_contexts(contexts);

        let main = reader.task_target("main").await.unwrap();
        let pipeline = reader.task_target("pipeline-run-0").await.unwrap();

        assert_eq!(pipeline.repository_path, worktree);
        assert_ne!(pipeline.resource_key, main.resource_key);
        assert!(pipeline.resource_key.starts_with("pipeline-worktree:"));
        assert!(reader.task_target("pipeline-gone").await.is_err());
    }
}
