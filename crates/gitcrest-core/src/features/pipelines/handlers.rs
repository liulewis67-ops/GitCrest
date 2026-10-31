use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::StatusCode,
    Json,
};

use crate::{
    api::error::{ApiError, ApiErrorCode},
    domain::{
        error::RepositoryError,
        pipeline::{
            validate_rules, PipelineAppSettings, PipelineRepositorySettings, PipelineRuleError,
        },
    },
    state::AppState,
};

use super::{
    dto::{
        ListRunsQuery, PipelineAppSettingsBody, PipelineRepositorySettingsRequest,
        PipelineRepositorySettingsResponse, PipelineRulesBody, PipelineRunActionKind,
        PipelineRunActionRequest, PipelineRunsBody, StartPipelineRunRequest,
    },
    service::{PipelineRunDto, PipelineServiceError, RunAction, StartRun},
};

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        ApiErrorCode::RequestInvalid,
        message,
    )
}

fn storage_error(_: impl std::fmt::Debug) -> ApiError {
    ApiError::from_repository_error(RepositoryError::StorageUnavailable)
}

fn rule_message(error: PipelineRuleError) -> String {
    match error {
        PipelineRuleError::EmptyRuleId => "Every rule needs an id.".into(),
        PipelineRuleError::EmptyName => "Every rule needs a name.".into(),
        PipelineRuleError::EmptyBranchPattern => "Every rule needs a branch pattern.".into(),
        PipelineRuleError::NoTargets => "A rule needs at least one target branch.".into(),
        PipelineRuleError::EmptyTarget => "Every target needs a branch and a remote name.".into(),
        PipelineRuleError::DuplicateTarget(branch) => {
            format!("{branch} is listed twice as a target.")
        }
        PipelineRuleError::TargetMatchesTrigger(branch) => {
            format!("Target {branch} matches the rule's own branch pattern.")
        }
        PipelineRuleError::UnknownPlaceholder(name) => {
            format!("The commit message uses an unknown placeholder {{{name}}}.")
        }
        PipelineRuleError::UnbalancedTemplate => {
            "The commit message template has unbalanced braces.".into()
        }
        PipelineRuleError::DuplicateRuleId(id) => format!("Rule id {id} is used twice."),
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, RepositoryError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(storage_error)?
        .map_err(ApiError::from_repository_error)
}

async fn require_repository(state: &AppState, repo_id: &str) -> Result<(), ApiError> {
    state
        .repository_targets
        .read_target(repo_id)
        .await
        .map(|_| ())
        .map_err(ApiError::from_repository_error)
}

fn app_body(settings: PipelineAppSettings) -> PipelineAppSettingsBody {
    PipelineAppSettingsBody {
        execution_mode: settings.execution_mode,
        in_place_dirty_policy: settings.in_place_dirty_policy,
    }
}

pub(super) async fn get_app_settings(
    State(state): State<AppState>,
) -> Result<Json<PipelineAppSettingsBody>, ApiError> {
    let store = state.pipeline_store.clone();
    let settings = blocking(move || store.pipeline_app_settings()).await?;
    Ok(Json(app_body(settings)))
}

pub(super) async fn put_app_settings(
    State(state): State<AppState>,
    request: Result<Json<PipelineAppSettingsBody>, JsonRejection>,
) -> Result<Json<PipelineAppSettingsBody>, ApiError> {
    let Json(request) =
        request.map_err(|_| invalid("An executionMode and inPlaceDirtyPolicy are required."))?;
    let settings = PipelineAppSettings {
        execution_mode: request.execution_mode,
        in_place_dirty_policy: request.in_place_dirty_policy,
    };
    let store = state.pipeline_store.clone();
    blocking(move || store.set_pipeline_app_settings(settings)).await?;
    Ok(Json(app_body(settings)))
}

async fn repository_settings_response(
    state: &AppState,
    repo_id: &str,
) -> Result<Json<PipelineRepositorySettingsResponse>, ApiError> {
    let store = state.pipeline_store.clone();
    let repo_id = repo_id.to_owned();
    let (app, repository) = blocking(move || {
        Ok((
            store.pipeline_app_settings()?,
            store.pipeline_repository_settings(&repo_id)?,
        ))
    })
    .await?;
    let effective = app.resolve(repository);
    Ok(Json(PipelineRepositorySettingsResponse {
        execution_mode: repository.execution_mode,
        in_place_dirty_policy: repository.in_place_dirty_policy,
        effective_execution_mode: effective.execution_mode,
        effective_in_place_dirty_policy: effective.in_place_dirty_policy,
    }))
}

pub(super) async fn get_repository_settings(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<PipelineRepositorySettingsResponse>, ApiError> {
    require_repository(&state, &repo_id).await?;
    repository_settings_response(&state, &repo_id).await
}

pub(super) async fn put_repository_settings(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<PipelineRepositorySettingsRequest>, JsonRejection>,
) -> Result<Json<PipelineRepositorySettingsResponse>, ApiError> {
    let Json(request) = request.map_err(|_| {
        invalid("executionMode and inPlaceDirtyPolicy must be a known value or null.")
    })?;
    require_repository(&state, &repo_id).await?;
    let settings = PipelineRepositorySettings {
        execution_mode: request.execution_mode,
        in_place_dirty_policy: request.in_place_dirty_policy,
    };
    let store = state.pipeline_store.clone();
    let id = repo_id.clone();
    blocking(move || store.set_pipeline_repository_settings(&id, settings)).await?;
    repository_settings_response(&state, &repo_id).await
}

pub(super) async fn get_rules(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
) -> Result<Json<PipelineRulesBody>, ApiError> {
    require_repository(&state, &repo_id).await?;
    let store = state.pipeline_store.clone();
    let rules = blocking(move || store.list_pipeline_rules(&repo_id)).await?;
    Ok(Json(PipelineRulesBody { rules }))
}

pub(super) async fn put_rules(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<PipelineRulesBody>, JsonRejection>,
) -> Result<Json<PipelineRulesBody>, ApiError> {
    let Json(mut request) =
        request.map_err(|_| invalid("A list of valid pipeline rules is required."))?;
    require_repository(&state, &repo_id).await?;
    validate_rules(&request.rules).map_err(|error| invalid(rule_message(error)))?;
    for rule in &mut request.rules {
        rule.normalize();
    }
    let store = state.pipeline_store.clone();
    let rules = request.rules.clone();
    blocking(move || store.replace_pipeline_rules(&repo_id, &rules)).await?;
    Ok(Json(request))
}

fn service_error(error: PipelineServiceError) -> ApiError {
    match error {
        PipelineServiceError::Storage => storage_error(()),
        PipelineServiceError::RunNotFound => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::PipelineRunNotFound,
            "The pipeline run was not found.",
        ),
        PipelineServiceError::RuleNotFound => ApiError::new(
            StatusCode::NOT_FOUND,
            ApiErrorCode::PipelineRuleNotFound,
            "The pipeline rule was not found.",
        ),
        PipelineServiceError::Conflict(message) => ApiError::new(
            StatusCode::CONFLICT,
            ApiErrorCode::PipelineRunConflict,
            message,
        ),
        PipelineServiceError::Invalid(message) => invalid(message),
    }
}

pub(super) async fn start_run(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    request: Result<Json<StartPipelineRunRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<PipelineRunDto>), ApiError> {
    let Json(request) = request.map_err(|_| {
        invalid(
            "Send a runId to confirm a run, or a ruleId, sourceBranch and sourceOid to start one.",
        )
    })?;
    require_repository(&state, &repo_id).await?;
    let start = match request {
        StartPipelineRunRequest {
            run_id: Some(run_id),
            rule_id: None,
            source_branch: None,
            source_oid: None,
            targets,
        } => StartRun::Confirm { run_id, targets },
        StartPipelineRunRequest {
            run_id: None,
            rule_id: Some(rule_id),
            source_branch: Some(source_branch),
            source_oid: Some(source_oid),
            targets,
        } => StartRun::Manual {
            rule_id,
            source_branch,
            source_oid,
            targets,
        },
        _ => {
            return Err(invalid(
                "Send either a runId, or a ruleId with sourceBranch and sourceOid.",
            ))
        }
    };
    let run = state
        .pipelines
        .start_run(&repo_id, start)
        .await
        .map_err(service_error)?;
    Ok((StatusCode::ACCEPTED, Json(run)))
}

pub(super) async fn list_runs(
    State(state): State<AppState>,
    Path(repo_id): Path<String>,
    query: Result<Query<ListRunsQuery>, QueryRejection>,
) -> Result<Json<PipelineRunsBody>, ApiError> {
    let Query(query) = query.map_err(|_| invalid("limit must be a positive integer."))?;
    require_repository(&state, &repo_id).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let runs = state
        .pipelines
        .list_runs(&repo_id, limit)
        .map_err(service_error)?;
    Ok(Json(PipelineRunsBody { runs }))
}

pub(super) async fn get_run(
    State(state): State<AppState>,
    Path((repo_id, run_id)): Path<(String, String)>,
) -> Result<Json<PipelineRunDto>, ApiError> {
    require_repository(&state, &repo_id).await?;
    state
        .pipelines
        .run(&repo_id, &run_id)
        .map(Json)
        .map_err(service_error)
}

pub(super) async fn run_action(
    State(state): State<AppState>,
    Path((repo_id, run_id)): Path<(String, String)>,
    request: Result<Json<PipelineRunActionRequest>, JsonRejection>,
) -> Result<Json<PipelineRunDto>, ApiError> {
    let Json(request) = request.map_err(|_| invalid("A known pipeline run action is required."))?;
    require_repository(&state, &repo_id).await?;
    let action = match request.action {
        PipelineRunActionKind::Resume => RunAction::Resume,
        PipelineRunActionKind::SkipTarget => RunAction::SkipTarget,
        PipelineRunActionKind::Stop => RunAction::Stop,
    };
    state
        .pipelines
        .act(&repo_id, &run_id, action)
        .await
        .map(Json)
        .map_err(service_error)
}
