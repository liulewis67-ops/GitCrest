use std::collections::HashMap;

use crate::ports::branch_activity::BranchActivityStorePort;

use super::RepositoryStore;

impl BranchActivityStorePort for RepositoryStore {
    fn branch_activity(&self, resource_key: &str) -> Result<HashMap<String, i64>, String> {
        let connection = self.connection.lock().map_err(|error| error.to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT full_name, last_activity_at_ms FROM branch_activity WHERE resource_key=?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([resource_key], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())
    }

    fn record_branch_activity(
        &self,
        resource_key: &str,
        full_names: &[String],
        at_ms: i64,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        for full_name in full_names {
            transaction.execute(
                "INSERT INTO branch_activity (resource_key, full_name, last_activity_at_ms) VALUES (?1, ?2, ?3)
                 ON CONFLICT(resource_key, full_name) DO UPDATE SET last_activity_at_ms=MAX(last_activity_at_ms, excluded.last_activity_at_ms)",
                rusqlite::params![resource_key, full_name, at_ms],
            ).map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_activity_across_reopen_and_isolates_shared_repository_keys() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("activity.sqlite");
        let branch = vec!["refs/heads/main".to_owned()];
        {
            let store = RepositoryStore::open(&database).unwrap();
            store
                .record_branch_activity("common-git-dir", &branch, 2000)
                .unwrap();
            store
                .record_branch_activity("common-git-dir", &branch, 1000)
                .unwrap();
            store
                .record_branch_activity("other-git-dir", &branch, 3000)
                .unwrap();
        }
        let reopened = RepositoryStore::open(&database).unwrap();
        assert_eq!(
            reopened.branch_activity("common-git-dir").unwrap()[&branch[0]],
            2000
        );
        assert_eq!(
            reopened.branch_activity("other-git-dir").unwrap()[&branch[0]],
            3000
        );
    }
}
