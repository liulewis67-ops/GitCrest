use rusqlite::{params, OptionalExtension};

use crate::{
    domain::task::{TaskSnapshot, TaskStatus},
    ports::tasks::TaskStorePort,
};

use super::RepositoryStore;

impl RepositoryStore {
    pub fn save_task_snapshot(
        &self,
        task_id: &str,
        repo_id: &str,
        status: &str,
        snapshot: &str,
        created_at_ms: i64,
        updated_at_ms: i64,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .execute(
                "INSERT INTO tasks (task_id, repo_id, status, snapshot_json, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(task_id) DO UPDATE SET status=excluded.status, snapshot_json=excluded.snapshot_json, updated_at_ms=excluded.updated_at_ms",
                params![task_id, repo_id, status, snapshot, created_at_ms, updated_at_ms],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "DELETE FROM tasks WHERE status IN ('succeeded', 'failed', 'cancelled') AND updated_at_ms < ?1 - COALESCE((SELECT retention_days FROM task_settings WHERE id=1), 15) * 86400000",
                [super::now_ms()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_task_snapshots(&self) -> Result<Vec<(String, String, String)>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let mut statement = connection
            .prepare("SELECT task_id, status, snapshot_json FROM tasks ORDER BY created_at_ms ASC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }
}

impl TaskStorePort for RepositoryStore {
    fn task_retention_days(&self) -> Result<u64, crate::domain::error::RepositoryError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)?;
        connection
            .query_row(
                "SELECT retention_days FROM task_settings WHERE id=1",
                [],
                |row| row.get::<_, u32>(0),
            )
            .optional()
            .map(|days| u64::from(days.unwrap_or(15)))
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn set_task_retention_days(
        &self,
        days: u64,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        let days = i64::try_from(days)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)?;
        connection.execute("INSERT INTO task_settings (id, retention_days) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET retention_days=excluded.retention_days", [days])
            .map(|_| ()).map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn prune_task_snapshots(
        &self,
        before_ms: u128,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)?;
        connection.execute("DELETE FROM tasks WHERE status IN ('succeeded', 'failed', 'cancelled') AND updated_at_ms < ?1", [before_ms.min(i64::MAX as u128) as i64])
            .map(|_| ()).map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn list_task_snapshots(
        &self,
    ) -> Result<Vec<TaskSnapshot>, crate::domain::error::RepositoryError> {
        RepositoryStore::list_task_snapshots(self)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)?
            .into_iter()
            .map(|(_task_id, _stored_status, snapshot_json)| {
                serde_json::from_str(&snapshot_json)
                    .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
            })
            .collect()
    }

    fn save_task_snapshot(
        &self,
        snapshot: &TaskSnapshot,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        let serialized = serde_json::to_string(snapshot)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)?;
        RepositoryStore::save_task_snapshot(
            self,
            &snapshot.task_id,
            snapshot.repo_id.as_deref().unwrap_or_default(),
            task_status_label(snapshot.status),
            &serialized,
            snapshot.created_at_ms.min(i64::MAX as u128) as i64,
            snapshot.updated_at_ms.min(i64::MAX as u128) as i64,
        )
        .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }
}

fn task_status_label(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Queued => "queued",
        TaskStatus::Running => "running",
        TaskStatus::WaitingForInput => "waitingForInput",
        TaskStatus::Succeeded => "succeeded",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    }
}
