use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};
use tokio::sync::{Mutex, OwnedRwLockReadGuard, RwLock};

use crate::{
    domain::operation::{
        GitOperation, NewOperation, OperationStatus, OperationStepStatus, OperationUpdate,
        OperationWaitReason,
    },
    ports::operations::{OperationResourcePort, OperationStoreError, OperationStorePort},
};

#[derive(Clone)]
pub(crate) struct WriteAccess {
    closing: Arc<std::sync::atomic::AtomicBool>,
    resources: Arc<dyn OperationResourcePort>,
    store: Arc<dyn OperationStorePort>,
    locks: Arc<Mutex<HashMap<String, Weak<RwLock<()>>>>>,
    paths: super::path_scopes::PathScopes,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WriteAccessError {
    Unavailable,
    Repository(crate::domain::error::RepositoryError),
    Owned { operation_id: String },
}

/// Must outlive the actual write, not merely its admission check.
pub(crate) struct WritePermit {
    _guard: OwnedRwLockReadGuard<()>,
    pub(super) locations: Arc<super::path_scopes::PathLease>,
}

/// Internal operation execution, serialized even against another caller using
/// the same owner. This does not authorize any recovery action on its own.
pub(crate) struct OperationWritePermit {
    pub(super) resource_key: String,
    _guard: tokio::sync::OwnedRwLockWriteGuard<()>,
    pub(super) locations: Arc<super::path_scopes::PathLease>,
}

pub(crate) struct SubmodulePermit {
    _trees: super::path_scopes::PathLease,
}

pub(crate) struct DirectoryPermit {
    _trees: super::path_scopes::PathLease,
    pub(crate) paths: Vec<std::path::PathBuf>,
}

impl WriteAccess {
    pub(crate) async fn enter_operation(
        &self,
        repo_id: &str,
        operation_id: &str,
        expected_version: i64,
    ) -> Result<OperationWritePermit, WriteAccessError> {
        self.ensure_open()?;
        let resource = self
            .resources
            .operation_locations(repo_id)
            .await
            .map_err(WriteAccessError::Repository)?;
        let locations = Arc::new(self.paths.locations(resource.locations.clone()).await);
        let guard = self.lock(&resource.key).await.write_owned().await;
        let current = self
            .resources
            .operation_locations(repo_id)
            .await
            .map_err(WriteAccessError::Repository)?;
        if current.key != resource.key
            || current.primary != resource.primary
            || current.locations != resource.locations
        {
            return Err(WriteAccessError::Unavailable);
        }
        let store = self.store.clone();
        let id = operation_id.to_owned();
        let operation = tokio::task::spawn_blocking(move || {
            let operation = store.operation(&id)?.ok_or(OperationStoreError::NotFound)?;
            if operation.version != expected_version
                || operation.state.status.is_terminal()
                || store.operation_owner(&operation.resource_key)?.as_deref() != Some(&id)
                || store
                    .repository_operation_owner(&operation.repo_id)?
                    .as_deref()
                    != Some(&id)
            {
                return Err(OperationStoreError::InvalidTransition);
            }
            Ok(operation)
        })
        .await
        .map_err(|_| WriteAccessError::Unavailable)?
        .map_err(|_| WriteAccessError::Unavailable)?;
        if operation.repo_id != repo_id || operation.resource_key != resource.key {
            return Err(WriteAccessError::Unavailable);
        }
        self.check_tree_owners(
            &resource.locations,
            Some((&operation.repo_id, &operation.request_id)),
        )
        .await?;
        self.ensure_open()?;
        Ok(OperationWritePermit {
            resource_key: resource.key,
            _guard: guard,
            locations,
        })
    }

    pub(crate) async fn operation_task_key(
        &self,
        expected: &GitOperation,
    ) -> Result<String, OperationStoreError> {
        self.ensure_open()
            .map_err(|_| OperationStoreError::Unavailable)?;
        let store = self.store.clone();
        let id = expected.operation_id.clone();
        let version = expected.version;
        let current = tokio::task::spawn_blocking(move || {
            let current = store.operation(&id)?.ok_or(OperationStoreError::NotFound)?;
            if current.version != version {
                return Err(OperationStoreError::VersionConflict);
            }
            if current.state.status.is_terminal()
                || store.operation_owner(&current.resource_key)?.as_deref() != Some(&id)
                || store
                    .repository_operation_owner(&current.repo_id)?
                    .as_deref()
                    != Some(&id)
            {
                return Err(OperationStoreError::InvalidTransition);
            }
            Ok(current)
        })
        .await
        .map_err(|_| OperationStoreError::Unavailable)??;
        if current.repo_id != expected.repo_id || current.resource_key != expected.resource_key {
            return Err(OperationStoreError::InvalidTransition);
        }
        let resource = self
            .resources
            .operation_locations(&current.repo_id)
            .await
            .map_err(|_| OperationStoreError::Unavailable)?;
        if resource.key != current.resource_key {
            return Err(OperationStoreError::InvalidTransition);
        }
        self.resources
            .operation_execution_key(&current.repo_id)
            .await
            .map_err(|_| OperationStoreError::Unavailable)
    }

    pub(super) async fn verify_execution_key(
        &self,
        repo_id: &str,
        expected: &str,
    ) -> Result<(), WriteAccessError> {
        let current = self
            .resources
            .operation_execution_key(repo_id)
            .await
            .map_err(WriteAccessError::Repository)?;
        if current != expected {
            return Err(WriteAccessError::Unavailable);
        }
        Ok(())
    }
    pub(crate) fn new(
        resources: Arc<dyn OperationResourcePort>,
        store: Arc<dyn OperationStorePort>,
    ) -> Self {
        Self {
            closing: Arc::default(),
            resources,
            store,
            locks: Arc::default(),
            paths: super::path_scopes::PathScopes::default(),
        }
    }

    pub(crate) fn begin_shutdown(&self) {
        self.closing
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn ensure_open(&self) -> Result<(), WriteAccessError> {
        if self.closing.load(std::sync::atomic::Ordering::SeqCst) {
            Err(WriteAccessError::Unavailable)
        } else {
            Ok(())
        }
    }

    async fn lock(&self, key: &str) -> Arc<RwLock<()>> {
        let mut locks = self.locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(RwLock::new(()));
        locks.insert(key.into(), Arc::downgrade(&lock));
        lock
    }

    pub(crate) async fn enter(&self, repo_id: &str) -> Result<WritePermit, WriteAccessError> {
        self.ensure_open()?;
        let resource = self
            .resources
            .operation_locations(repo_id)
            .await
            .map_err(WriteAccessError::Repository)?;
        let points = resource.locations.clone();
        let locations = Arc::new(self.paths.locations(points.clone()).await);
        let permit = self
            .enter_resource(resource.key.clone(), Some(repo_id.to_owned()), locations)
            .await?;
        let current = self
            .resources
            .operation_locations(repo_id)
            .await
            .map_err(WriteAccessError::Repository)?;
        if current.key != resource.key
            || current.primary != resource.primary
            || current.locations != resource.locations
        {
            return Err(WriteAccessError::Unavailable);
        }
        self.check_ancestor_owners(&points).await?;
        self.ensure_open()?;
        Ok(permit)
    }

    /// Admission reads durable ownership without reserving execution access.
    /// Accepted tasks remain visible and cancellable while their scopes wait.
    pub(crate) async fn check(&self, repo_id: &str) -> Result<(), WriteAccessError> {
        self.ensure_open()?;
        let key = self
            .resources
            .operation_resource_key(repo_id)
            .await
            .map_err(WriteAccessError::Repository)?;
        self.check_resource(key, Some(repo_id.to_owned())).await
    }

    /// Forgetting a catalog entry must work when its Git directory is missing.
    /// The database foreign key still prevents deletion racing an owner claim.
    pub(crate) async fn check_catalog(&self, repo_id: &str) -> Result<(), WriteAccessError> {
        self.ensure_open()?;
        let store = self.store.clone();
        let repo_id = repo_id.to_owned();
        let operation_id =
            tokio::task::spawn_blocking(move || store.repository_operation_owner(&repo_id))
                .await
                .map_err(|_| WriteAccessError::Unavailable)?
                .map_err(|_| WriteAccessError::Unavailable)?;
        match operation_id {
            Some(operation_id) => Err(WriteAccessError::Owned { operation_id }),
            None => Ok(()),
        }
    }

    pub(crate) async fn enter_paths(
        &self,
        paths: &[std::path::PathBuf],
    ) -> Result<Vec<WritePermit>, WriteAccessError> {
        self.ensure_open()?;
        let mut keys = Vec::new();
        let mut points = Vec::new();
        for path in paths {
            let resource = self
                .resources
                .operation_locations_for_path(path)
                .await
                .map_err(WriteAccessError::Repository)?;
            points.extend(resource.locations);
            keys.push(resource.key);
        }
        keys.sort();
        keys.dedup();
        let locations = Arc::new(self.paths.locations(points.clone()).await);
        let mut permits = Vec::new();
        for key in keys {
            permits.push(self.enter_resource(key, None, locations.clone()).await?);
        }
        self.check_ancestor_owners(&points).await?;
        self.ensure_open()?;
        Ok(permits)
    }

    async fn active_owners(&self) -> Result<Vec<GitOperation>, WriteAccessError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.active_operations())
            .await
            .map_err(|_| WriteAccessError::Unavailable)?
            .map_err(|_| WriteAccessError::Unavailable)
    }

    async fn check_ancestor_owners(
        &self,
        points: &[std::path::PathBuf],
    ) -> Result<(), WriteAccessError> {
        for owner in self.active_owners().await? {
            let resource = self
                .resources
                .operation_locations(&owner.repo_id)
                .await
                .map_err(WriteAccessError::Repository)?;
            if points.iter().any(|point| {
                point.starts_with(&owner.resource_key)
                    || resource
                        .locations
                        .iter()
                        .any(|root| point.starts_with(root))
            }) {
                return Err(WriteAccessError::Owned {
                    operation_id: owner.operation_id,
                });
            }
        }
        Ok(())
    }

    async fn check_tree_owners(
        &self,
        trees: &[std::path::PathBuf],
        request: Option<(&str, &str)>,
    ) -> Result<(), WriteAccessError> {
        for owner in self.active_owners().await? {
            if request == Some((owner.repo_id.as_str(), owner.request_id.as_str())) {
                continue;
            }
            let mut locations = self
                .resources
                .operation_locations(&owner.repo_id)
                .await
                .map_err(WriteAccessError::Repository)?
                .locations;
            locations.push(owner.resource_key.into());
            if trees.iter().any(|tree| {
                locations
                    .iter()
                    .any(|root| tree.starts_with(root) || root.starts_with(tree))
            }) {
                return Err(WriteAccessError::Owned {
                    operation_id: owner.operation_id,
                });
            }
        }
        Ok(())
    }

    pub(super) async fn directory_write_for(
        &self,
        repo_id: &str,
        paths: Vec<std::path::PathBuf>,
        parent_lease: Arc<super::path_scopes::PathLease>,
    ) -> Result<DirectoryPermit, WriteAccessError> {
        let resource = self
            .resources
            .operation_locations(repo_id)
            .await
            .map_err(WriteAccessError::Repository)?;
        let mut trees = Vec::new();
        for path in paths {
            let path = crate::storage::repository_paths::canonicalize_prospective(&path)
                .await
                .map_err(WriteAccessError::Repository)?;
            if resource.primary.starts_with(&path)
                || path.starts_with(&resource.key)
                || std::path::Path::new(&resource.key).starts_with(&path)
            {
                return Err(WriteAccessError::Repository(
                    crate::domain::error::RepositoryError::InvalidPath,
                ));
            }
            trees.push(path);
        }
        self.reserve_directory_trees(trees, Some(parent_lease))
            .await
    }

    pub(crate) async fn repository_directory_write(
        &self,
        repo_id: &str,
        paths: Vec<std::path::PathBuf>,
        permit: &WritePermit,
    ) -> Result<DirectoryPermit, WriteAccessError> {
        self.directory_write_for(repo_id, paths, permit.locations.clone())
            .await
    }

    /// Startup sweep has one combined location lease for all repositories.
    /// The caller must validate the application's managed directory boundary.
    pub(crate) async fn managed_directory_write(
        &self,
        paths: Vec<std::path::PathBuf>,
        repositories: &[std::path::PathBuf],
        permit: Option<&WritePermit>,
    ) -> Result<DirectoryPermit, WriteAccessError> {
        let mut trees = Vec::new();
        for path in paths {
            trees.push(
                crate::storage::repository_paths::canonicalize_prospective(&path)
                    .await
                    .map_err(WriteAccessError::Repository)?,
            );
        }
        for repository in repositories {
            let resource = self
                .resources
                .operation_locations_for_path(repository)
                .await
                .map_err(WriteAccessError::Repository)?;
            if trees.iter().any(|tree| {
                resource.primary.starts_with(tree)
                    || std::path::Path::new(&resource.key).starts_with(tree)
                    || tree.starts_with(&resource.key)
            }) {
                return Err(WriteAccessError::Repository(
                    crate::domain::error::RepositoryError::InvalidPath,
                ));
            }
        }
        self.reserve_directory_trees(trees, permit.map(|permit| permit.locations.clone()))
            .await
    }

    async fn reserve_directory_trees(
        &self,
        trees: Vec<std::path::PathBuf>,
        parent: Option<Arc<super::path_scopes::PathLease>>,
    ) -> Result<DirectoryPermit, WriteAccessError> {
        self.ensure_open()?;
        let lease = match parent {
            Some(parent) => self
                .paths
                .directory_trees(trees.clone(), parent)
                .await
                .ok_or(WriteAccessError::Unavailable)?,
            None => self.paths.trees(trees.clone()).await,
        };
        self.check_tree_owners(&trees, None).await?;
        self.ensure_open()?;
        for tree in &trees {
            if crate::storage::repository_paths::canonicalize_prospective(tree)
                .await
                .map_err(WriteAccessError::Repository)?
                != *tree
            {
                return Err(WriteAccessError::Unavailable);
            }
        }
        Ok(DirectoryPermit {
            _trees: lease,
            paths: trees,
        })
    }

    #[cfg(test)]
    pub(crate) async fn submodule_update(
        &self,
        repo_id: &str,
        trees: Vec<std::path::PathBuf>,
    ) -> Result<SubmodulePermit, WriteAccessError> {
        self.submodule_update_for(repo_id, trees, None).await
    }

    pub(super) async fn submodule_update_for(
        &self,
        repo_id: &str,
        trees: Vec<std::path::PathBuf>,
        parent_lease: Option<Arc<super::path_scopes::PathLease>>,
    ) -> Result<SubmodulePermit, WriteAccessError> {
        self.ensure_open()?;
        let parent = self
            .resources
            .operation_locations(repo_id)
            .await
            .map_err(WriteAccessError::Repository)?;
        if trees
            .iter()
            .any(|tree| parent.locations.iter().any(|point| point.starts_with(tree)))
        {
            return Err(WriteAccessError::Repository(
                crate::domain::error::RepositoryError::InvalidPath,
            ));
        }
        let lease = match parent_lease {
            Some(parent) => self.paths.nested_trees(trees.clone(), parent).await.ok_or(
                WriteAccessError::Repository(crate::domain::error::RepositoryError::InvalidPath),
            )?,
            None => self.paths.trees(trees.clone()).await,
        };
        self.check_tree_owners(&trees, None).await?;
        self.ensure_open()?;
        Ok(SubmodulePermit { _trees: lease })
    }

    /// Run before accepting HTTP work or starting pipeline recovery. This does
    /// not infer Git outcomes: interrupted intent remains unknown until G3's
    /// repository reconciliation can prove what actually happened.
    pub(crate) async fn recover_interrupted(&self) -> Result<(), OperationStoreError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            for mut operation in store.active_operations()? {
                if store.operation_owner(&operation.resource_key)?.as_deref()
                    != Some(&operation.operation_id)
                {
                    return Err(OperationStoreError::InvalidTransition);
                }
                let interrupted = matches!(
                    operation.state.status,
                    OperationStatus::Queued | OperationStatus::Running
                ) || operation
                    .steps
                    .iter()
                    .any(|step| step.status == OperationStepStatus::IntentRecorded);
                if !interrupted {
                    continue;
                }
                let mut state = operation.state.clone();
                state.status = OperationStatus::RecoveryRequired;
                state.wait_reason = Some(OperationWaitReason::OutcomeUnknown);
                let steps: Vec<_> = operation
                    .steps
                    .iter()
                    .filter(|step| step.status == OperationStepStatus::IntentRecorded)
                    .cloned()
                    .collect();
                if steps.is_empty() {
                    store.update_operation(
                        &operation.operation_id,
                        operation.version,
                        OperationUpdate {
                            state,
                            step: None,
                            backup: None,
                        },
                    )?;
                } else {
                    for mut step in steps {
                        step.status = OperationStepStatus::Unknown;
                        operation = store.update_operation(
                            &operation.operation_id,
                            operation.version,
                            OperationUpdate {
                                state: state.clone(),
                                step: Some(step),
                                backup: None,
                            },
                        )?;
                    }
                }
            }
            Ok(())
        })
        .await
        .map_err(|_| OperationStoreError::Unavailable)?
    }

    async fn enter_resource(
        &self,
        key: String,
        repo_id: Option<String>,
        locations: Arc<super::path_scopes::PathLease>,
    ) -> Result<WritePermit, WriteAccessError> {
        let guard = self.lock(&key).await.read_owned().await;
        self.check_resource(key, repo_id).await?;
        Ok(WritePermit {
            _guard: guard,
            locations,
        })
    }

    async fn check_resource(
        &self,
        key: String,
        repo_id: Option<String>,
    ) -> Result<(), WriteAccessError> {
        let store = self.store.clone();
        let operation_id = tokio::task::spawn_blocking(move || {
            if let Some(owner) = store.operation_owner(&key)? {
                return Ok(Some(owner));
            }
            match repo_id {
                Some(repo_id) => store.repository_operation_owner(&repo_id),
                None => Ok(None),
            }
        })
        .await
        .map_err(|_| WriteAccessError::Unavailable)?
        .map_err(|_| WriteAccessError::Unavailable)?;
        if let Some(operation_id) = operation_id {
            return Err(WriteAccessError::Owned { operation_id });
        }
        Ok(())
    }

    /// Only backend orchestration may call this; no public creation endpoint is
    /// enabled until the recovery flow is complete. The caller's resource key is
    /// deliberately replaced with the backend's canonical identity.
    #[allow(dead_code)]
    pub(crate) async fn claim(
        &self,
        mut input: NewOperation,
    ) -> Result<GitOperation, OperationStoreError> {
        let store = self.store.clone();
        let repo_id = input.repo_id.clone();
        let request_id = input.request_id.clone();
        if let Some(existing) =
            tokio::task::spawn_blocking(move || store.operation_request(&repo_id, &request_id))
                .await
                .map_err(|_| OperationStoreError::Unavailable)??
        {
            return if existing.request.fingerprint() == input.request.fingerprint() {
                Ok(existing)
            } else {
                Err(OperationStoreError::RequestConflict)
            };
        }
        self.ensure_open()
            .map_err(|_| OperationStoreError::Unavailable)?;
        let resource = self
            .resources
            .operation_locations(&input.repo_id)
            .await
            .map_err(|_| OperationStoreError::Unavailable)?;
        let key = resource.key;
        let locations = self.paths.trees(resource.locations.clone()).await;
        let _exclusive = self.lock(&key).await.write_owned().await;
        let current = self
            .resources
            .operation_locations(&input.repo_id)
            .await
            .map_err(|_| OperationStoreError::Unavailable)?;
        if current.key != key
            || current.primary != resource.primary
            || current.locations != resource.locations
        {
            return Err(OperationStoreError::InvalidTransition);
        }
        self.check_tree_owners(
            &resource.locations,
            Some((&input.repo_id, &input.request_id)),
        )
        .await
        .map_err(|error| match error {
            WriteAccessError::Owned { operation_id } => {
                OperationStoreError::ResourceOwned { operation_id }
            }
            _ => OperationStoreError::Unavailable,
        })?;
        input.resource_key = key;
        self.ensure_open()
            .map_err(|_| OperationStoreError::Unavailable)?;
        let store = self.store.clone();
        // Keep ownership of the exclusive guard in the blocking work too. If the
        // caller is cancelled, a still-running SQLite claim must remain ordered
        // before newly admitted Git writes.
        tokio::task::spawn_blocking(move || {
            let _exclusive = _exclusive;
            let _locations = locations;
            store.create_operation(input)
        })
        .await
        .map_err(|_| OperationStoreError::Unavailable)?
    }
}

#[cfg(test)]
mod tests;
