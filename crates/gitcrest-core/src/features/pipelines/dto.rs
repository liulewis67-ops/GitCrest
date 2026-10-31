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
