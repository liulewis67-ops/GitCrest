use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Scope {
    Point(PathBuf),
    Tree(PathBuf),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn pending(scopes: &PathScopes, count: usize) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if scopes.0.state.lock().unwrap().pending.len() == count {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn subtree_uses_path_components_and_leaves_other_roots_available() {
        let scopes = PathScopes::default();
        let tree = scopes.trees(vec!["/repo/module".into()]).await;
        let unrelated = scopes.locations(vec!["/repo/module-copy".into()]).await;
        let shared = scopes.clone();
        let child =
            tokio::spawn(async move { shared.locations(vec!["/repo/module/nested".into()]).await });
        pending(&scopes, 1).await;
        assert!(!child.is_finished());
        drop(tree);
        let child = child.await.unwrap();
        drop((child, unrelated));
        assert_eq!(scopes.active_count(), 0);
    }

    #[tokio::test]
    async fn cancelling_a_pending_tree_does_not_leave_a_reservation() {
        let scopes = PathScopes::default();
        let active = scopes.locations(vec!["/repo/module".into()]).await;
        let shared = scopes.clone();
        let tree = tokio::spawn(async move { shared.trees(vec!["/repo".into()]).await });
        pending(&scopes, 1).await;
        tree.abort();
        assert!(matches!(tree.await, Err(error) if error.is_cancelled()));
        let new_reader = tokio::time::timeout(
            Duration::from_secs(1),
            scopes.locations(vec!["/repo/other".into()]),
        )
        .await
        .unwrap();
        drop((active, new_reader));
        assert_eq!(scopes.active_count(), 0);
    }

    #[tokio::test]
    async fn a_queued_tree_prevents_later_locations_from_starving_it() {
        let scopes = PathScopes::default();
        let active = scopes.locations(vec!["/repo/module".into()]).await;
        let shared = scopes.clone();
        let tree = tokio::spawn(async move { shared.trees(vec!["/repo".into()]).await });
        pending(&scopes, 1).await;
        let shared = scopes.clone();
        let reader = tokio::spawn(async move { shared.locations(vec!["/repo/new".into()]).await });
        pending(&scopes, 2).await;
        drop(active);
        let tree = tree.await.unwrap();
        assert!(!reader.is_finished());
        drop(tree);
        drop(reader.await.unwrap());
        assert_eq!(scopes.active_count(), 0);
    }

    #[tokio::test]
    async fn a_running_inner_task_can_finish_before_an_outer_tree_waiting_for_it() {
        let scopes = PathScopes::default();
        let parent = Arc::new(scopes.locations(vec!["/outer/inner".into()]).await);
        let shared = scopes.clone();
        let outer = tokio::spawn(async move { shared.trees(vec!["/outer".into()]).await });
        pending(&scopes, 1).await;
        let nested = tokio::time::timeout(
            Duration::from_secs(1),
            scopes.nested_trees(vec!["/outer/inner/module".into()], parent.clone()),
        )
        .await
        .unwrap()
        .unwrap();
        drop(parent);
        assert!(
            !outer.is_finished(),
            "nested lease retains the parent location until it finishes"
        );
        drop(nested);
        drop(
            tokio::time::timeout(Duration::from_secs(1), outer)
                .await
                .unwrap()
                .unwrap(),
        );
        assert_eq!(scopes.active_count(), 0);
    }

    #[tokio::test]
    async fn nested_access_cannot_cover_its_own_parent_location() {
        let scopes = PathScopes::default();
        let parent = Arc::new(scopes.locations(vec!["/outer/inner".into()]).await);
        assert!(scopes
            .nested_trees(vec!["/outer".into()], parent)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn cross_linked_locations_fail_one_inner_request_instead_of_deadlocking() {
        let scopes = PathScopes::default();
        let a = Arc::new(
            scopes
                .locations(vec!["/a".into(), "/b/module/linked-a".into()])
                .await,
        );
        let b = Arc::new(
            scopes
                .locations(vec!["/b".into(), "/a/module/linked-b".into()])
                .await,
        );
        let shared = scopes.clone();
        let parent = a.clone();
        let first =
            tokio::spawn(
                async move { shared.nested_trees(vec!["/a/module".into()], parent).await },
            );
        pending(&scopes, 1).await;
        assert!(tokio::time::timeout(
            Duration::from_secs(1),
            scopes.nested_trees(vec!["/b/module".into()], b.clone())
        )
        .await
        .unwrap()
        .is_none());
        drop(b);
        drop(
            tokio::time::timeout(Duration::from_secs(1), first)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
        );
        drop(a);
        assert_eq!(scopes.active_count(), 0);
    }
}

impl Scope {
    fn conflicts(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Point(_), Self::Point(_)) => false,
            (Self::Tree(tree), Self::Point(point)) | (Self::Point(point), Self::Tree(tree)) => {
                point.starts_with(tree)
            }
            (Self::Tree(a), Self::Tree(b)) => a.starts_with(b) || b.starts_with(a),
        }
    }
}

fn conflicts(a: &[Scope], b: &[Scope]) -> bool {
    a.iter()
        .any(|left| b.iter().any(|right| left.conflicts(right)))
}

#[derive(Default)]
struct State {
    next_id: u64,
    active: Vec<(u64, Vec<Scope>, Option<u64>)>,
    pending: VecDeque<(u64, Vec<Scope>, Option<u64>)>,
}

impl State {
    fn root(&self, mut id: u64) -> u64 {
        while let Some(parent) = self
            .active
            .iter()
            .find(|(other, _, _)| *other == id)
            .and_then(|(_, _, parent)| *parent)
        {
            id = parent;
        }
        id
    }

    fn cycle(&self, scopes: &[Scope], parent: u64) -> bool {
        let parent_lease = parent;
        let parent = self.root(parent);
        let mut pending = vec![(scopes, true)];
        let mut visited = std::collections::HashSet::new();
        while let Some((request, initial)) = pending.pop() {
            for (id, active, _) in &self.active {
                if initial && *id == parent_lease {
                    continue;
                }
                if !conflicts(request, active) {
                    continue;
                }
                let blocked = self.root(*id);
                if blocked == parent {
                    return true;
                }
                if visited.insert(blocked) {
                    for (_, waiting, owner) in &self.pending {
                        if owner.is_some_and(|owner| self.root(owner) == blocked) {
                            pending.push((waiting, false));
                        }
                    }
                }
            }
        }
        false
    }
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    changed: Notify,
}

/// Coordinates recursive filesystem effects with repository writes and owner
/// claims. Unrelated subtrees remain independent; requests take all scopes at
/// once so partially acquired path sets cannot deadlock each other.
#[derive(Clone, Default)]
pub(super) struct PathScopes(Arc<Inner>);

pub(super) struct PathLease {
    inner: Arc<Inner>,
    id: u64,
    _parent: Option<Arc<PathLease>>,
}

impl Drop for PathLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.active.retain(|(id, _, _)| *id != self.id);
            state.pending.retain(|(id, _, _)| *id != self.id);
        }
        self.inner.changed.notify_waiters();
    }
}

impl PathScopes {
    pub(super) async fn locations(&self, paths: Vec<PathBuf>) -> PathLease {
        self.acquire(paths.into_iter().map(Scope::Point).collect(), None)
            .await
            .expect("top-level scope has no parent dependency")
    }

    pub(super) async fn trees(&self, paths: Vec<PathBuf>) -> PathLease {
        self.acquire(paths.into_iter().map(Scope::Tree).collect(), None)
            .await
            .expect("top-level scope has no parent dependency")
    }

    pub(super) async fn nested_trees(
        &self,
        paths: Vec<PathBuf>,
        parent: Arc<PathLease>,
    ) -> Option<PathLease> {
        let scopes: Vec<_> = paths.into_iter().map(Scope::Tree).collect();
        if !Arc::ptr_eq(&self.0, &parent.inner) {
            return None;
        }
        {
            let state = self.0.state.lock().expect("path scope state is healthy");
            let (_, held, _) = state.active.iter().find(|(id, _, _)| *id == parent.id)?;
            if conflicts(&scopes, held) {
                return None;
            }
        }
        self.acquire(scopes, Some(parent)).await
    }

    /// Directory operations may replace a linked worktree already represented
    /// in their own location lease. Callers must first protect the viewed root
    /// and Git directory; only the requesting task's own points are exempted.
    pub(super) async fn directory_trees(
        &self,
        paths: Vec<PathBuf>,
        parent: Arc<PathLease>,
    ) -> Option<PathLease> {
        if !Arc::ptr_eq(&self.0, &parent.inner) {
            return None;
        }
        {
            let state = self.0.state.lock().expect("path scope state is healthy");
            let (_, held, _) = state.active.iter().find(|(id, _, _)| *id == parent.id)?;
            if !held.iter().all(|scope| matches!(scope, Scope::Point(_))) {
                return None;
            }
        }
        self.acquire(paths.into_iter().map(Scope::Tree).collect(), Some(parent))
            .await
    }

    async fn acquire(
        &self,
        scopes: Vec<Scope>,
        parent: Option<Arc<PathLease>>,
    ) -> Option<PathLease> {
        let parent_id = parent.as_ref().map(|lease| lease.id);
        let id = {
            let mut state = self.0.state.lock().expect("path scope state is healthy");
            state.next_id = state
                .next_id
                .checked_add(1)
                .expect("path lease id does not overflow");
            let id = state.next_id;
            state.pending.push_back((id, scopes.clone(), parent_id));
            id
        };
        // Drop also removes a pending request when the awaiting caller is cancelled.
        let lease = PathLease {
            inner: self.0.clone(),
            id,
            _parent: parent,
        };
        loop {
            let changed = self.0.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let granted = {
                let mut state = self.0.state.lock().expect("path scope state is healthy");
                // Cross-linked worktrees can make two inner updates wait on
                // each other's already-held locations. Stop the later request
                // before Git starts, allowing the earlier task to finish.
                if parent_id.is_some_and(|parent| state.cycle(&scopes, parent)) {
                    return None;
                }
                let earlier = state
                    .pending
                    .iter()
                    .take_while(|(other, _, _)| *other != id)
                    .any(|(_, pending, _)| {
                        let waiting_for_parent = parent_id
                            .and_then(|parent| state.active.iter().find(|(id, _, _)| *id == parent))
                            .is_some_and(|(_, held, _)| conflicts(pending, held));
                        conflicts(&scopes, pending) && !waiting_for_parent
                    });
                if !earlier
                    && !state
                        .active
                        .iter()
                        .any(|(id, active, _)| Some(*id) != parent_id && conflicts(&scopes, active))
                {
                    state.pending.retain(|(pending, _, _)| *pending != id);
                    state.active.push((id, scopes.clone(), parent_id));
                    true
                } else {
                    false
                }
            };
            if granted {
                return Some(lease);
            }
            changed.await;
        }
    }

    #[cfg(test)]
    pub(super) fn active_count(&self) -> usize {
        self.0.state.lock().unwrap().active.len()
    }
}
