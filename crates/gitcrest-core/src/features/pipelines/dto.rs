use serde::{Deserialize, Serialize};

use crate::domain::pipeline::{ExecutionMode, InPlaceDirtyPolicy, PipelineRule};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PipelineAppSettingsBody {
    pub(super) execution_mode: ExecutionMode,
    pub(super) in_place_dirty_policy: InPlaceDirtyPolicy,
}

/// A missing or null field clears that repository override.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PipelineRepositorySettingsRequest {
    #[serde(default)]
    pub(super) execution_mode: Option<ExecutionMode>,
    #[serde(default)]
    pub(super) in_place_dirty_policy: Option<InPlaceDirtyPolicy>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PipelineRepositorySettingsResponse {
    pub(super) execution_mode: Option<ExecutionMode>,
    pub(super) in_place_dirty_policy: Option<InPlaceDirtyPolicy>,
    pub(super) effective_execution_mode: ExecutionMode,
    pub(super) effective_in_place_dirty_policy: InPlaceDirtyPolicy,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PipelineRulesBody {
    pub(super) rules: Vec<PipelineRule>,
}

/// Either confirms a run waiting for confirmation (`runId`) or starts a rule
/// manually (`ruleId`, `sourceBranch`, `sourceOid`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StartPipelineRunRequest {
    #[serde(default)]
    pub(super) run_id: Option<String>,
    #[serde(default)]
    pub(super) rule_id: Option<String>,
    #[serde(default)]
    pub(super) source_branch: Option<String>,
    #[serde(default)]
    pub(super) source_oid: Option<String>,
    #[serde(default)]
    pub(super) targets: Option<Vec<String>>,
    /// Manual runs only: run in this mode this once.
    #[serde(default)]
    pub(super) execution_mode: Option<ExecutionMode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PipelineRunActionRequest {
    pub(super) action: PipelineRunActionKind,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum PipelineRunActionKind {
    Resume,
    SkipTarget,
    Stop,
    ReturnToSource,
    Discard,
}

#[derive(Deserialize)]
pub(super) struct ListRunsQuery {
    pub(super) limit: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PipelineRunsBody {
    pub(super) runs: Vec<super::service::PipelineRunDto>,
}
