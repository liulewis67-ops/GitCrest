use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};

use tokio::sync::Mutex;

#[derive(Default)]
pub(super) struct ResourceLocks {
    locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl ResourceLocks {
    pub(super) async fn for_resource(&self, resource_key: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(resource_key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(resource_key.to_owned(), Arc::downgrade(&lock));
        lock
    }
}
