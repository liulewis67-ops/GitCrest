use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::{
    domain::{
        error::RepositoryError,
        pipeline::{
            ExecutionMode, InPlaceDirtyPolicy, PipelineAppSettings, PipelineRepositorySettings,
            PipelineRule, PipelineRun, PipelineStep, RunStatus, StepState,
        },
    },
    ports::pipelines::PipelineStorePort,
};

use super::{now_ms, RepositoryStore};

const RUN_COLUMNS: &str = "run_id, repo_id, rule_snapshot_json, source_branch, source_oid, \
     execution_mode, status, shelf_id, created_at_ms, updated_at_ms";

fn storage<E>(_: E) -> RepositoryError {
    RepositoryError::StorageUnavailable
}

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<PipelineRun> {
    let invalid = |column: usize| {
        rusqlite::Error::InvalidColumnType(
            column,
            "pipeline column".into(),
            rusqlite::types::Type::Text,
        )
    };
    let rule_json: String = row.get(2)?;
    let mode: String = row.get(5)?;
    let status: String = row.get(6)?;
    Ok(PipelineRun {
        run_id: row.get(0)?,
        repo_id: row.get(1)?,
        rule: serde_json::from_str(&rule_json).map_err(|_| invalid(2))?,
        source_branch: row.get(3)?,
        source_oid: row.get(4)?,
        execution_mode: ExecutionMode::parse(&mode).ok_or_else(|| invalid(5))?,
        status: RunStatus::parse(&status).ok_or_else(|| invalid(6))?,
        shelf_id: row.get(7)?,
        created_at_ms: row.get(8)?,
        updated_at_ms: row.get(9)?,
        steps: Vec::new(),
    })
}

fn step_from_row(row: &Row<'_>) -> rusqlite::Result<PipelineStep> {
    let state: String = row.get(4)?;
    Ok(PipelineStep {
        run_id: row.get(0)?,
        position: row.get(1)?,
        target_branch: row.get(2)?,
        remote: row.get(3)?,
        state: StepState::parse(&state).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(4, "step state".into(), rusqlite::types::Type::Text)
        })?,
        lease_oid: row.get(5)?,
        merge_oid: row.get(6)?,
        workspace_path: row.get(7)?,
        ephemeral_repo_id: row.get(8)?,
        message: row.get(9)?,
    })
}

fn load_steps(connection: &Connection, run: &mut PipelineRun) -> rusqlite::Result<()> {
    let mut statement = connection.prepare(
        "SELECT run_id, position, target_branch, remote, state, lease_oid, merge_oid, \
         workspace_path, ephemeral_repo_id, message FROM pipeline_steps \
         WHERE run_id=?1 ORDER BY position",
    )?;
    run.steps = statement
        .query_map([&run.run_id], step_from_row)?
        .collect::<Result<_, _>>()?;
    Ok(())
}

fn load_runs(
    connection: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
) -> rusqlite::Result<Vec<PipelineRun>> {
    let mut statement = connection.prepare(sql)?;
    let mut runs = statement
        .query_map(args, run_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    for run in &mut runs {
        load_steps(connection, run)?;
    }
    Ok(runs)
}

impl RepositoryStore {
    /// Registers a minimal repository row so pipeline tests satisfy the foreign keys.
    /// Like `insert_test_repository`, with the real path of a repository on disk.
    #[cfg(test)]
    pub(crate) fn insert_test_repository_at(&self, repo_id: &str, path: &std::path::Path) {
        self.connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO repositories (repo_id, path, branch, detached, state, is_favorite, \n                 last_accessed_at, availability) VALUES (?1, ?2, 'main', 0, 'normal', 0, 0, \n                 'available')",
                params![repo_id, path.to_string_lossy()],
            )
            .unwrap();
    }

    #[cfg(test)]
    pub(crate) fn insert_test_repository(&self, repo_id: &str) {
        self.connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO repositories (repo_id, path, branch, detached, state, is_favorite, \n                 last_accessed_at, availability) VALUES (?1, ?2, 'main', 0, 'normal', 0, 0, \n                 'available')",
                params![repo_id, format!("/tmp/{repo_id}")],
            )
            .unwrap();
    }
}

impl PipelineStorePort for RepositoryStore {
    fn list_pipeline_rules(&self, repo_id: &str) -> Result<Vec<PipelineRule>, RepositoryError> {
        let connection = self.connection.lock().map_err(storage)?;
        let mut statement = connection
            .prepare(
                "SELECT definition_json FROM pipeline_rules WHERE repo_id=?1 ORDER BY position",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([repo_id], |row| row.get::<_, String>(0))
            .map_err(storage)?;
        rows.map(|row| {
            let json = row.map_err(storage)?;
            serde_json::from_str(&json).map_err(storage)
        })
        .collect()
    }

    fn replace_pipeline_rules(
        &self,
        repo_id: &str,
        rules: &[PipelineRule],
    ) -> Result<(), RepositoryError> {
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection.transaction().map_err(storage)?;
        transaction
            .execute("DELETE FROM pipeline_rules WHERE repo_id=?1", [repo_id])
            .map_err(storage)?;
        let now = now_ms();
        for (position, rule) in rules.iter().enumerate() {
            let json = serde_json::to_string(rule).map_err(storage)?;
            transaction
                .execute(
                    "INSERT INTO pipeline_rules (repo_id, rule_id, position, definition_json, \
                     updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![repo_id, rule.rule_id, position as i64, json, now],
                )
                .map_err(storage)?;
        }
        transaction.commit().map_err(storage)
    }

    fn pipeline_app_settings(&self) -> Result<PipelineAppSettings, RepositoryError> {
        let connection = self.connection.lock().map_err(storage)?;
        let row: Option<(String, String)> = connection
            .query_row(
                "SELECT execution_mode, in_place_dirty_policy FROM pipeline_app_settings WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let defaults = PipelineAppSettings::default();
        Ok(match row {
            Some((mode, policy)) => PipelineAppSettings {
                execution_mode: ExecutionMode::parse(&mode).unwrap_or(defaults.execution_mode),
                in_place_dirty_policy: InPlaceDirtyPolicy::parse(&policy)
                    .unwrap_or(defaults.in_place_dirty_policy),
            },
            None => defaults,
        })
    }

    fn set_pipeline_app_settings(
        &self,
        settings: PipelineAppSettings,
    ) -> Result<(), RepositoryError> {
        let connection = self.connection.lock().map_err(storage)?;
        connection
            .execute(
                "INSERT INTO pipeline_app_settings (id, execution_mode, in_place_dirty_policy) \n                 VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET \n                 execution_mode=excluded.execution_mode, \n                 in_place_dirty_policy=excluded.in_place_dirty_policy",
                params![
                    settings.execution_mode.as_str(),
                    settings.in_place_dirty_policy.as_str()
                ],
            )
            .map_err(storage)?;
        Ok(())
    }

    fn pipeline_repository_settings(
        &self,
        repo_id: &str,
    ) -> Result<PipelineRepositorySettings, RepositoryError> {
        let connection = self.connection.lock().map_err(storage)?;
        let row: Option<(Option<String>, Option<String>)> = connection
            .query_row(
                "SELECT execution_mode, in_place_dirty_policy FROM pipeline_repository_settings \
                 WHERE repo_id=?1",
                [repo_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let (mode, policy) = row.unwrap_or_default();
        Ok(PipelineRepositorySettings {
            execution_mode: mode.as_deref().and_then(ExecutionMode::parse),
            in_place_dirty_policy: policy.as_deref().and_then(InPlaceDirtyPolicy::parse),
        })
    }

    fn set_pipeline_repository_settings(
        &self,
        repo_id: &str,
        settings: PipelineRepositorySettings,
    ) -> Result<(), RepositoryError> {
        let connection = self.connection.lock().map_err(storage)?;
        connection
            .execute(
                "INSERT INTO pipeline_repository_settings (repo_id, execution_mode, \
                 in_place_dirty_policy) VALUES (?1, ?2, ?3) ON CONFLICT(repo_id) DO UPDATE SET \
                 execution_mode=excluded.execution_mode, \
                 in_place_dirty_policy=excluded.in_place_dirty_policy",
                params![
                    repo_id,
                    settings.execution_mode.map(ExecutionMode::as_str),
                    settings
                        .in_place_dirty_policy
                        .map(InPlaceDirtyPolicy::as_str),
                ],
            )
            .map_err(storage)?;
        Ok(())
    }

    fn insert_pipeline_run(&self, run: &PipelineRun) -> Result<(), RepositoryError> {
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection.transaction().map_err(storage)?;
        let rule_json = serde_json::to_string(&run.rule).map_err(storage)?;
        transaction
            .execute(
                &format!(
                    "INSERT INTO pipeline_runs ({RUN_COLUMNS}) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
                ),
                params![
                    run.run_id,
                    run.repo_id,
                    rule_json,
                    run.source_branch,
                    run.source_oid,
                    run.execution_mode.as_str(),
                    run.status.as_str(),
                    run.shelf_id,
                    run.created_at_ms,
                    run.updated_at_ms,
                ],
            )
            .map_err(storage)?;
        for step in &run.steps {
            transaction
                .execute(
                    "INSERT INTO pipeline_steps (run_id, position, target_branch, remote, state, \
                     lease_oid, merge_oid, workspace_path, ephemeral_repo_id, message) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        step.run_id,
                        step.position,
                        step.target_branch,
                        step.remote,
                        step.state.as_str(),
                        step.lease_oid,
                        step.merge_oid,
                        step.workspace_path,
                        step.ephemeral_repo_id,
                        step.message,
                    ],
                )
                .map_err(storage)?;
        }
        transaction.commit().map_err(storage)
    }

    fn update_pipeline_run(
        &self,
        run_id: &str,
        status: RunStatus,
        shelf_id: Option<&str>,
    ) -> Result<(), RepositoryError> {
        let connection = self.connection.lock().map_err(storage)?;
        let changed = connection
            .execute(
                "UPDATE pipeline_runs SET status=?2, shelf_id=?3, updated_at_ms=?4 WHERE run_id=?1",
                params![run_id, status.as_str(), shelf_id, now_ms()],
            )
            .map_err(storage)?;
        if changed == 0 {
            return Err(RepositoryError::RepositoryNotFound);
        }
        Ok(())
    }

    fn update_pipeline_step(&self, step: &PipelineStep) -> Result<(), RepositoryError> {
        let connection = self.connection.lock().map_err(storage)?;
        let changed = connection
            .execute(
                "UPDATE pipeline_steps SET state=?3, lease_oid=?4, merge_oid=?5, \
                 workspace_path=?6, ephemeral_repo_id=?7, message=?8 \
                 WHERE run_id=?1 AND position=?2",
                params![
                    step.run_id,
                    step.position,
                    step.state.as_str(),
                    step.lease_oid,
                    step.merge_oid,
                    step.workspace_path,
                    step.ephemeral_repo_id,
                    step.message,
                ],
            )
            .map_err(storage)?;
        if changed == 0 {
            return Err(RepositoryError::RepositoryNotFound);
        }
        connection
            .execute(
                "UPDATE pipeline_runs SET updated_at_ms=?2 WHERE run_id=?1",
                params![step.run_id, now_ms()],
            )
            .map_err(storage)?;
        Ok(())
    }

    fn pipeline_run(&self, run_id: &str) -> Result<Option<PipelineRun>, RepositoryError> {
        let connection = self.connection.lock().map_err(storage)?;
        let runs = load_runs(
            &connection,
            &format!("SELECT {RUN_COLUMNS} FROM pipeline_runs WHERE run_id=?1"),
            [run_id],
        )
        .map_err(storage)?;
        Ok(runs.into_iter().next())
    }

    fn list_pipeline_runs(
        &self,
        repo_id: &str,
        limit: u32,
    ) -> Result<Vec<PipelineRun>, RepositoryError> {
        let connection = self.connection.lock().map_err(storage)?;
        load_runs(
            &connection,
            &format!(
                "SELECT {RUN_COLUMNS} FROM pipeline_runs WHERE repo_id=?1 \
                 ORDER BY created_at_ms DESC, rowid DESC LIMIT ?2"
            ),
            params![repo_id, limit],
        )
        .map_err(storage)
    }

    fn list_active_pipeline_runs(&self) -> Result<Vec<PipelineRun>, RepositoryError> {
        let connection = self.connection.lock().map_err(storage)?;
        load_runs(
            &connection,
            &format!(
                "SELECT {RUN_COLUMNS} FROM pipeline_runs \
                 WHERE status NOT IN ('succeeded','partiallySucceeded','failed','cancelled') \
                 ORDER BY created_at_ms, rowid"
            ),
            [],
        )
        .map_err(storage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::pipeline::tests::{rule, run, step};
    use crate::domain::pipeline::{Confirmation, StepState};

    fn store_with_repository(repo_id: &str) -> RepositoryStore {
        let store = RepositoryStore::default();
        store.insert_test_repository(repo_id);
        store
    }

    #[test]
    fn rules_round_trip_in_order_and_replace_as_a_unit() {
        let store = store_with_repository("repo");
        assert!(store.list_pipeline_rules("repo").unwrap().is_empty());
        let mut second = rule();
        second.rule_id = "r_02".into();
        second.confirmation = Confirmation::Auto;
        store
            .replace_pipeline_rules("repo", &[second.clone(), rule()])
            .unwrap();
        assert_eq!(
            store.list_pipeline_rules("repo").unwrap(),
            vec![second.clone(), rule()]
        );
        store.replace_pipeline_rules("repo", &[rule()]).unwrap();
        assert_eq!(store.list_pipeline_rules("repo").unwrap(), vec![rule()]);
        assert!(store.list_pipeline_rules("other").unwrap().is_empty());
    }

    #[test]
    fn app_settings_default_then_persist() {
        let store = RepositoryStore::default();
        assert_eq!(
            store.pipeline_app_settings().unwrap(),
            PipelineAppSettings::default()
        );
        let settings = PipelineAppSettings {
            execution_mode: ExecutionMode::SwitchInPlace,
            in_place_dirty_policy: InPlaceDirtyPolicy::Refuse,
        };
        store.set_pipeline_app_settings(settings).unwrap();
        assert_eq!(store.pipeline_app_settings().unwrap(), settings);
    }

    #[test]
    fn repository_settings_default_to_none_and_round_trip() {
        let store = store_with_repository("repo");
        assert_eq!(
            store.pipeline_repository_settings("repo").unwrap(),
            PipelineRepositorySettings::default()
        );
        let settings = PipelineRepositorySettings {
            execution_mode: Some(ExecutionMode::SwitchInPlace),
            in_place_dirty_policy: Some(InPlaceDirtyPolicy::Refuse),
        };
        store
            .set_pipeline_repository_settings("repo", settings)
            .unwrap();
        assert_eq!(
            store.pipeline_repository_settings("repo").unwrap(),
            settings
        );
        store
            .set_pipeline_repository_settings("repo", PipelineRepositorySettings::default())
            .unwrap();
        assert_eq!(
            store.pipeline_repository_settings("repo").unwrap(),
            PipelineRepositorySettings::default()
        );
    }

    #[test]
    fn runs_and_steps_round_trip_and_update() {
        let store = store_with_repository("repo");
        let mut r = run(vec![
            step(0, StepState::Pending),
            step(1, StepState::Pending),
        ]);
        store.insert_pipeline_run(&r).unwrap();
        assert_eq!(store.pipeline_run("run").unwrap(), Some(r.clone()));
        assert_eq!(store.pipeline_run("missing").unwrap(), None);

        r.steps[0].state = StepState::Merging;
        r.steps[0].lease_oid = Some("b".repeat(40));
        r.steps[0].merge_oid = Some("c".repeat(40));
        r.steps[0].workspace_path = Some("/data/pipelines/run/uat".into());
        r.steps[0].ephemeral_repo_id = Some("eph".into());
        r.steps[0].message = Some("note".into());
        store.update_pipeline_step(&r.steps[0]).unwrap();
        store
            .update_pipeline_run("run", RunStatus::WaitingForConflicts, Some("shelf"))
            .unwrap();
        let loaded = store.pipeline_run("run").unwrap().unwrap();
        assert_eq!(loaded.steps, r.steps);
        assert_eq!(loaded.status, RunStatus::WaitingForConflicts);
        assert_eq!(loaded.shelf_id.as_deref(), Some("shelf"));
        assert_eq!(loaded.rule, rule());

        let mut missing = r.steps[0].clone();
        missing.run_id = "nope".into();
        assert!(store.update_pipeline_step(&missing).is_err());
        assert!(store
            .update_pipeline_run("nope", RunStatus::Failed, None)
            .is_err());
    }

    #[test]
    fn lists_runs_newest_first_and_only_active_runs_for_recovery() {
        let store = store_with_repository("repo");
        let mut first = run(vec![step(0, StepState::Done)]);
        first.run_id = "first".into();
        first.steps[0].run_id = "first".into();
        first.created_at_ms = 1;
        let mut second = run(vec![step(0, StepState::Pending)]);
        second.run_id = "second".into();
        second.steps[0].run_id = "second".into();
        second.created_at_ms = 2;
        store.insert_pipeline_run(&first).unwrap();
        store.insert_pipeline_run(&second).unwrap();
        store
            .update_pipeline_run("first", RunStatus::Succeeded, None)
            .unwrap();

        let listed: Vec<_> = store
            .list_pipeline_runs("repo", 10)
            .unwrap()
            .into_iter()
            .map(|r| r.run_id)
            .collect();
        assert_eq!(listed, ["second", "first"]);
        assert_eq!(store.list_pipeline_runs("repo", 1).unwrap().len(), 1);
        let active: Vec<_> = store
            .list_active_pipeline_runs()
            .unwrap()
            .into_iter()
            .map(|r| r.run_id)
            .collect();
        assert_eq!(active, ["second"]);
    }

    #[test]
    fn forgetting_a_repository_removes_its_pipeline_data() {
        let store = store_with_repository("repo");
        store.replace_pipeline_rules("repo", &[rule()]).unwrap();
        store
            .insert_pipeline_run(&run(vec![step(0, StepState::Pending)]))
            .unwrap();
        assert!(store.forget("repo").unwrap());
        assert!(store.list_pipeline_rules("repo").unwrap().is_empty());
        assert_eq!(store.pipeline_run("run").unwrap(), None);
        let steps: i64 = store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM pipeline_steps", [], |row| row.get(0))
            .unwrap();
        assert_eq!(steps, 0);
    }
}
