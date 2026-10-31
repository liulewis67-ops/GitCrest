use crate::domain::{
    error::RepositoryError,
    pipeline::{PipelineRepositorySettings, PipelineRule, PipelineRun, PipelineStep, RunStatus},
};

pub(crate) trait PipelineStorePort: Send + Sync {
    fn list_pipeline_rules(&self, repo_id: &str) -> Result<Vec<PipelineRule>, RepositoryError>;

    /// Replaces the whole ordered rule list in one transaction.
    fn replace_pipeline_rules(
        &self,
        repo_id: &str,
        rules: &[PipelineRule],
    ) -> Result<(), RepositoryError>;

    fn pipeline_repository_settings(
        &self,
        repo_id: &str,
    ) -> Result<PipelineRepositorySettings, RepositoryError>;

    fn set_pipeline_repository_settings(
        &self,
        repo_id: &str,
        settings: PipelineRepositorySettings,
    ) -> Result<(), RepositoryError>;

    /// Inserts the run together with its steps.
    fn insert_pipeline_run(&self, run: &PipelineRun) -> Result<(), RepositoryError>;

    fn update_pipeline_run(
        &self,
        run_id: &str,
        status: RunStatus,
        shelf_id: Option<&str>,
    ) -> Result<(), RepositoryError>;

    /// Persists every mutable field of the step, keyed by run and position.
    fn update_pipeline_step(&self, step: &PipelineStep) -> Result<(), RepositoryError>;

    fn pipeline_run(&self, run_id: &str) -> Result<Option<PipelineRun>, RepositoryError>;

    /// Newest first.
    fn list_pipeline_runs(
        &self,
        repo_id: &str,
        limit: u32,
    ) -> Result<Vec<PipelineRun>, RepositoryError>;

    /// Runs that are not terminal, across all repositories, oldest first.
    fn list_active_pipeline_runs(&self) -> Result<Vec<PipelineRun>, RepositoryError>;
}
