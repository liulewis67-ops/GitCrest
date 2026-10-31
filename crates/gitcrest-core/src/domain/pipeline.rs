use serde::{Deserialize, Serialize};

const PROTECTED_EXACT: [&str; 2] = ["main", "master"];
const PROTECTED_PREFIXES: [&str; 2] = ["release/", "prod"];
const PLACEHOLDERS: [&str; 3] = ["source", "target", "sourceShortOid"];

pub(crate) const DEFAULT_COMMIT_MESSAGE_TEMPLATE: &str = "Merge branch '{source}' into {target}";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MergeMode {
    NoFastForward,
    FastForwardIfPossible,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConflictPolicy {
    OpenResolver,
    SkipTarget,
    StopRun,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AfterConflictResolved {
    Continue,
    Ask,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Confirmation {
    Ask,
    Auto,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum PipelineTrigger {
    #[serde(rename_all = "camelCase")]
    AfterPush { branch_pattern: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PipelineTarget {
    pub branch: String,
    pub remote: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PipelineRule {
    pub rule_id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: PipelineTrigger,
    pub targets: Vec<PipelineTarget>,
    pub merge_mode: MergeMode,
    pub commit_message_template: String,
    pub push_after_merge: bool,
    pub on_conflict: ConflictPolicy,
    pub after_conflict_resolved: AfterConflictResolved,
    pub confirmation: Confirmation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PipelineRuleError {
    EmptyRuleId,
    EmptyName,
    EmptyBranchPattern,
    NoTargets,
    EmptyTarget,
    DuplicateTarget(String),
    TargetMatchesTrigger(String),
    UnknownPlaceholder(String),
    UnbalancedTemplate,
    DuplicateRuleId(String),
}

impl PipelineTarget {
    pub(crate) fn is_protected(&self) -> bool {
        PROTECTED_EXACT.contains(&self.branch.as_str())
            || PROTECTED_PREFIXES
                .iter()
                .any(|prefix| self.branch.starts_with(prefix))
    }
}

impl PipelineTrigger {
    pub(crate) fn matches_branch(&self, branch: &str) -> bool {
        match self {
            Self::AfterPush { branch_pattern } => glob_match(branch_pattern, branch),
        }
    }

    fn pattern(&self) -> &str {
        match self {
            Self::AfterPush { branch_pattern } => branch_pattern,
        }
    }
}

impl PipelineRule {
    /// Whether a protected-looking target forces the confirmation dialog.
    pub(crate) fn has_protected_target(&self) -> bool {
        self.targets.iter().any(PipelineTarget::is_protected)
    }

    pub(crate) fn effective_confirmation(&self) -> Confirmation {
        if self.has_protected_target() {
            Confirmation::Ask
        } else {
            self.confirmation
        }
    }

    /// Applies the rules that are corrections rather than errors.
    pub(crate) fn normalize(&mut self) {
        self.confirmation = self.effective_confirmation();
    }

    pub(crate) fn validate(&self) -> Result<(), PipelineRuleError> {
        if self.rule_id.trim().is_empty() {
            return Err(PipelineRuleError::EmptyRuleId);
        }
        if self.name.trim().is_empty() {
            return Err(PipelineRuleError::EmptyName);
        }
        if self.trigger.pattern().trim().is_empty() {
            return Err(PipelineRuleError::EmptyBranchPattern);
        }
        if self.targets.is_empty() {
            return Err(PipelineRuleError::NoTargets);
        }
        let mut seen: Vec<(&str, &str)> = Vec::new();
        for target in &self.targets {
            if target.branch.trim().is_empty() || target.remote.trim().is_empty() {
                return Err(PipelineRuleError::EmptyTarget);
            }
            let key = (target.remote.as_str(), target.branch.as_str());
            if seen.contains(&key) {
                return Err(PipelineRuleError::DuplicateTarget(target.branch.clone()));
            }
            seen.push(key);
            if self.trigger.matches_branch(&target.branch) {
                return Err(PipelineRuleError::TargetMatchesTrigger(
                    target.branch.clone(),
                ));
            }
        }
        validate_template(&self.commit_message_template)
    }

    pub(crate) fn render_commit_message(
        &self,
        source: &str,
        target: &str,
        source_oid: &str,
    ) -> String {
        render_template(&self.commit_message_template, source, target, source_oid)
    }
}

/// Validates a whole ordered rule list as a unit.
pub(crate) fn validate_rules(rules: &[PipelineRule]) -> Result<(), PipelineRuleError> {
    for (index, rule) in rules.iter().enumerate() {
        rule.validate()?;
        if rules[..index]
            .iter()
            .any(|other| other.rule_id == rule.rule_id)
        {
            return Err(PipelineRuleError::DuplicateRuleId(rule.rule_id.clone()));
        }
    }
    Ok(())
}

fn validate_template(template: &str) -> Result<(), PipelineRuleError> {
    let mut rest = template;
    while let Some(start) = rest.find(['{', '}']) {
        if rest.as_bytes()[start] == b'}' {
            return Err(PipelineRuleError::UnbalancedTemplate);
        }
        let after = &rest[start + 1..];
        let Some(end) = after.find(['{', '}']) else {
            return Err(PipelineRuleError::UnbalancedTemplate);
        };
        if after.as_bytes()[end] == b'{' {
            return Err(PipelineRuleError::UnbalancedTemplate);
        }
        let name = &after[..end];
        if !PLACEHOLDERS.contains(&name) {
            return Err(PipelineRuleError::UnknownPlaceholder(name.to_string()));
        }
        rest = &after[end + 1..];
    }
    Ok(())
}

pub(crate) fn render_template(
    template: &str,
    source: &str,
    target: &str,
    source_oid: &str,
) -> String {
    let short: String = source_oid.chars().take(7).collect();
    template
        .replace("{source}", source)
        .replace("{target}", target)
        .replace("{sourceShortOid}", &short)
}

/// Glob over a short branch name: `*` and `?` stay inside one `/` segment,
/// `**` crosses segments.
pub(crate) fn glob_match(pattern: &str, name: &str) -> bool {
    fn go(pattern: &[u8], name: &[u8]) -> bool {
        match pattern.split_first() {
            None => name.is_empty(),
            Some((b'*', rest)) => {
                if let Some(rest) = rest.strip_prefix(b"*") {
                    (0..=name.len()).any(|skip| go(rest, &name[skip..]))
                } else {
                    let limit = name.iter().position(|b| *b == b'/').unwrap_or(name.len());
                    (0..=limit).any(|skip| go(rest, &name[skip..]))
                }
            }
            Some((b'?', rest)) => match name.split_first() {
                Some((c, tail)) if *c != b'/' => go(rest, tail),
                _ => false,
            },
            Some((c, rest)) => match name.split_first() {
                Some((n, tail)) if n == c => go(rest, tail),
                _ => false,
            },
        }
    }
    go(pattern.as_bytes(), name.as_bytes())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExecutionMode {
    TemporaryWorktree,
    SwitchInPlace,
}

impl ExecutionMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::TemporaryWorktree => "temporaryWorktree",
            Self::SwitchInPlace => "switchInPlace",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "temporaryWorktree" => Some(Self::TemporaryWorktree),
            "switchInPlace" => Some(Self::SwitchInPlace),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InPlaceDirtyPolicy {
    Shelve,
    Refuse,
}

impl InPlaceDirtyPolicy {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Shelve => "shelve",
            Self::Refuse => "refuse",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "shelve" => Some(Self::Shelve),
            "refuse" => Some(Self::Refuse),
            _ => None,
        }
    }
}

/// App-wide defaults used when a repository has no override.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PipelineAppSettings {
    pub execution_mode: ExecutionMode,
    pub in_place_dirty_policy: InPlaceDirtyPolicy,
}

impl Default for PipelineAppSettings {
    fn default() -> Self {
        Self {
            execution_mode: ExecutionMode::TemporaryWorktree,
            in_place_dirty_policy: InPlaceDirtyPolicy::Shelve,
        }
    }
}

impl PipelineAppSettings {
    /// Repository override first, then the app default.
    pub(crate) fn resolve(self, repository: PipelineRepositorySettings) -> Self {
        Self {
            execution_mode: repository.execution_mode.unwrap_or(self.execution_mode),
            in_place_dirty_policy: repository
                .in_place_dirty_policy
                .unwrap_or(self.in_place_dirty_policy),
        }
    }
}

/// Per-repository overrides; `None` means "use the app default".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PipelineRepositorySettings {
    pub execution_mode: Option<ExecutionMode>,
    pub in_place_dirty_policy: Option<InPlaceDirtyPolicy>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunStatus {
    PendingConfirmation,
    Running,
    WaitingForConflicts,
    /// GitCrest closed while the run was working; the user decides how to go on.
    Interrupted,
    Succeeded,
    PartiallySucceeded,
    Failed,
    Cancelled,
}

impl RunStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::PendingConfirmation => "pendingConfirmation",
            Self::Running => "running",
            Self::WaitingForConflicts => "waitingForConflicts",
            Self::Interrupted => "interrupted",
            Self::Succeeded => "succeeded",
            Self::PartiallySucceeded => "partiallySucceeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pendingConfirmation" => Self::PendingConfirmation,
            "running" => Self::Running,
            "waitingForConflicts" => Self::WaitingForConflicts,
            "interrupted" => Self::Interrupted,
            "succeeded" => Self::Succeeded,
            "partiallySucceeded" => Self::PartiallySucceeded,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::PartiallySucceeded | Self::Failed | Self::Cancelled
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StepState {
    Pending,
    Preparing,
    Merging,
    WaitingForConflicts,
    Pushing,
    Finishing,
    Done,
    UpToDate,
    Skipped,
    Failed,
}

impl StepState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Preparing => "preparing",
            Self::Merging => "merging",
            Self::WaitingForConflicts => "waitingForConflicts",
            Self::Pushing => "pushing",
            Self::Finishing => "finishing",
            Self::Done => "done",
            Self::UpToDate => "upToDate",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "preparing" => Self::Preparing,
            "merging" => Self::Merging,
            "waitingForConflicts" => Self::WaitingForConflicts,
            "pushing" => Self::Pushing,
            "finishing" => Self::Finishing,
            "done" => Self::Done,
            "upToDate" => Self::UpToDate,
            "skipped" => Self::Skipped,
            "failed" => Self::Failed,
            _ => return None,
        })
    }

    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Done | Self::UpToDate | Self::Skipped | Self::Failed
        )
    }

    pub(crate) fn is_success(self) -> bool {
        matches!(self, Self::Done | Self::UpToDate)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PipelineStep {
    pub run_id: String,
    pub position: u32,
    pub target_branch: String,
    pub remote: String,
    pub state: StepState,
    pub lease_oid: Option<String>,
    pub merge_oid: Option<String>,
    pub workspace_path: Option<String>,
    pub ephemeral_repo_id: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PipelineRun {
    pub run_id: String,
    pub repo_id: String,
    pub rule: PipelineRule,
    pub source_branch: String,
    pub source_oid: String,
    pub execution_mode: ExecutionMode,
    pub status: RunStatus,
    pub shelf_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub steps: Vec<PipelineStep>,
}

impl PipelineRun {
    /// Final status once no step is left to run. `None` while work remains.
    pub(crate) fn final_status(&self) -> Option<RunStatus> {
        if !self.steps.iter().all(|step| step.state.is_terminal()) {
            return None;
        }
        let successes = self.steps.iter().filter(|s| s.state.is_success()).count();
        Some(if successes == self.steps.len() {
            RunStatus::Succeeded
        } else if successes > 0 {
            RunStatus::PartiallySucceeded
        } else {
            RunStatus::Failed
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn rule() -> PipelineRule {
        PipelineRule {
            rule_id: "r_01".into(),
            name: "Promote feature".into(),
            enabled: true,
            trigger: PipelineTrigger::AfterPush {
                branch_pattern: "feature/*".into(),
            },
            targets: vec![
                PipelineTarget {
                    branch: "uat".into(),
                    remote: "origin".into(),
                },
                PipelineTarget {
                    branch: "dev".into(),
                    remote: "origin".into(),
                },
            ],
            merge_mode: MergeMode::NoFastForward,
            commit_message_template: DEFAULT_COMMIT_MESSAGE_TEMPLATE.into(),
            push_after_merge: true,
            on_conflict: ConflictPolicy::OpenResolver,
            after_conflict_resolved: AfterConflictResolved::Continue,
            confirmation: Confirmation::Ask,
        }
    }

    pub(crate) fn step(position: u32, state: StepState) -> PipelineStep {
        PipelineStep {
            run_id: "run".into(),
            position,
            target_branch: format!("t{position}"),
            remote: "origin".into(),
            state,
            lease_oid: None,
            merge_oid: None,
            workspace_path: None,
            ephemeral_repo_id: None,
            message: None,
        }
    }

    pub(crate) fn run(steps: Vec<PipelineStep>) -> PipelineRun {
        PipelineRun {
            run_id: "run".into(),
            repo_id: "repo".into(),
            rule: rule(),
            source_branch: "feature/1".into(),
            source_oid: "a".repeat(40),
            execution_mode: ExecutionMode::TemporaryWorktree,
            status: RunStatus::Running,
            shelf_id: None,
            created_at_ms: 10,
            updated_at_ms: 20,
            steps,
        }
    }

    #[test]
    fn glob_star_stays_in_segment_and_double_star_crosses() {
        assert!(glob_match("feature/*", "feature/1"));
        assert!(!glob_match("feature/*", "feature/a/b"));
        assert!(glob_match("feature/**", "feature/a/b"));
        assert!(glob_match("fix-?", "fix-1"));
        assert!(!glob_match("fix-?", "fix-/"));
        assert!(!glob_match("feature/*", "uat"));
        assert!(glob_match("*", "uat"));
    }

    #[test]
    fn valid_rule_passes() {
        assert_eq!(rule().validate(), Ok(()));
    }

    #[test]
    fn rejects_empty_fields_and_target_lists() {
        let mut r = rule();
        r.rule_id = " ".into();
        assert_eq!(r.validate(), Err(PipelineRuleError::EmptyRuleId));
        let mut r = rule();
        r.name = "".into();
        assert_eq!(r.validate(), Err(PipelineRuleError::EmptyName));
        let mut r = rule();
        r.trigger = PipelineTrigger::AfterPush {
            branch_pattern: "".into(),
        };
        assert_eq!(r.validate(), Err(PipelineRuleError::EmptyBranchPattern));
        let mut r = rule();
        r.targets.clear();
        assert_eq!(r.validate(), Err(PipelineRuleError::NoTargets));
        let mut r = rule();
        r.targets[0].branch = "".into();
        assert_eq!(r.validate(), Err(PipelineRuleError::EmptyTarget));
    }

    #[test]
    fn rejects_duplicate_targets_and_targets_matching_the_trigger() {
        let mut r = rule();
        r.targets.push(r.targets[0].clone());
        assert_eq!(
            r.validate(),
            Err(PipelineRuleError::DuplicateTarget("uat".into()))
        );
        let mut r = rule();
        r.targets[1].branch = "feature/other".into();
        assert_eq!(
            r.validate(),
            Err(PipelineRuleError::TargetMatchesTrigger(
                "feature/other".into()
            ))
        );
        let mut r = rule();
        r.trigger = PipelineTrigger::AfterPush {
            branch_pattern: "uat".into(),
        };
        assert_eq!(
            r.validate(),
            Err(PipelineRuleError::TargetMatchesTrigger("uat".into()))
        );
    }

    #[test]
    fn rejects_unknown_placeholders_and_unbalanced_braces() {
        let mut r = rule();
        r.commit_message_template = "Merge {branch}".into();
        assert_eq!(
            r.validate(),
            Err(PipelineRuleError::UnknownPlaceholder("branch".into()))
        );
        for bad in ["Merge {source", "Merge source}", "Merge {{source}}"] {
            let mut r = rule();
            r.commit_message_template = bad.into();
            assert_eq!(
                r.validate(),
                Err(PipelineRuleError::UnbalancedTemplate),
                "{bad}"
            );
        }
        let mut r = rule();
        r.commit_message_template = "plain".into();
        assert_eq!(r.validate(), Ok(()));
    }

    #[test]
    fn rejects_duplicate_rule_ids_in_a_list() {
        assert_eq!(
            validate_rules(&[rule(), rule()]),
            Err(PipelineRuleError::DuplicateRuleId("r_01".into()))
        );
        assert_eq!(validate_rules(&[]), Ok(()));
    }

    #[test]
    fn protected_targets_force_confirmation() {
        for branch in ["main", "master", "release/1.0", "production", "prod"] {
            let mut r = rule();
            r.targets[0].branch = branch.into();
            r.confirmation = Confirmation::Auto;
            assert_eq!(r.effective_confirmation(), Confirmation::Ask, "{branch}");
            r.normalize();
            assert_eq!(r.confirmation, Confirmation::Ask);
        }
        let mut r = rule();
        r.confirmation = Confirmation::Auto;
        assert_eq!(r.effective_confirmation(), Confirmation::Auto);
        let mut r = rule();
        r.targets[0].branch = "domain".into();
        assert!(!r.has_protected_target());
    }

    #[test]
    fn renders_templates() {
        assert_eq!(
            rule().render_commit_message("feature/1", "uat", "0123456789abcdef"),
            "Merge branch 'feature/1' into uat"
        );
        assert_eq!(
            render_template("{sourceShortOid} -> {target}", "s", "t", "0123456789"),
            "0123456 -> t"
        );
    }

    #[test]
    fn rule_json_uses_camel_case_and_round_trips() {
        let json = serde_json::to_value(rule()).unwrap();
        assert_eq!(json["trigger"]["kind"], "afterPush");
        assert_eq!(json["trigger"]["branchPattern"], "feature/*");
        assert_eq!(json["mergeMode"], "noFastForward");
        assert_eq!(json["onConflict"], "openResolver");
        let back: PipelineRule = serde_json::from_value(json).unwrap();
        assert_eq!(back, rule());
    }

    #[test]
    fn enum_strings_round_trip() {
        for s in [
            StepState::Pending,
            StepState::Preparing,
            StepState::Merging,
            StepState::WaitingForConflicts,
            StepState::Pushing,
            StepState::Finishing,
            StepState::Done,
            StepState::UpToDate,
            StepState::Skipped,
            StepState::Failed,
        ] {
            assert_eq!(StepState::parse(s.as_str()), Some(s));
        }
        for s in [
            RunStatus::PendingConfirmation,
            RunStatus::Running,
            RunStatus::WaitingForConflicts,
            RunStatus::Interrupted,
            RunStatus::Succeeded,
            RunStatus::PartiallySucceeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
        ] {
            assert_eq!(RunStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(StepState::parse("nope"), None);
        assert_eq!(ExecutionMode::parse("nope"), None);
        assert_eq!(InPlaceDirtyPolicy::parse("nope"), None);
    }

    #[test]
    fn repository_overrides_win_over_app_defaults() {
        let app = PipelineAppSettings::default();
        assert_eq!(app.execution_mode, ExecutionMode::TemporaryWorktree);
        assert_eq!(app.in_place_dirty_policy, InPlaceDirtyPolicy::Shelve);
        assert_eq!(app.resolve(PipelineRepositorySettings::default()), app);
        let resolved = app.resolve(PipelineRepositorySettings {
            execution_mode: Some(ExecutionMode::SwitchInPlace),
            in_place_dirty_policy: None,
        });
        assert_eq!(resolved.execution_mode, ExecutionMode::SwitchInPlace);
        assert_eq!(resolved.in_place_dirty_policy, InPlaceDirtyPolicy::Shelve);
    }

    #[test]
    fn final_status_follows_step_outcomes() {
        let mut r = run(vec![step(0, StepState::Done), step(1, StepState::Merging)]);
        assert_eq!(r.final_status(), None);
        r.steps[1].state = StepState::UpToDate;
        assert_eq!(r.final_status(), Some(RunStatus::Succeeded));
        r.steps[1].state = StepState::Skipped;
        assert_eq!(r.final_status(), Some(RunStatus::PartiallySucceeded));
        r.steps[0].state = StepState::Failed;
        assert_eq!(r.final_status(), Some(RunStatus::Failed));
    }
}
