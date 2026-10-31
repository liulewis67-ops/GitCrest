//! Exchange of pipeline rules through `.gitcrest/pipelines.json`.
//!
//! A repository file can never make GitCrest push on its own: importing always goes through
//! a review, and every imported rule starts out asking before it runs.

use serde::{Deserialize, Serialize};

use crate::domain::pipeline::{validate_rules, Confirmation, PipelineRule, PipelineRuleError};

pub(crate) const RULES_FILE_DIRECTORY: &str = ".gitcrest";
pub(crate) const RULES_FILE_NAME: &str = "pipelines.json";
pub(crate) const SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_FILE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_RULES: usize = 50;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RulesDocument {
    pub schema_version: u32,
    pub rules: Vec<PipelineRule>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SharingError {
    TooLarge,
    Malformed,
    UnsupportedVersion(u32),
    TooManyRules,
    /// The rule at this position (starting at 1) is not valid.
    InvalidRule(usize, PipelineRuleError),
}

pub(crate) fn export_document(rules: &[PipelineRule]) -> RulesDocument {
    RulesDocument {
        schema_version: SCHEMA_VERSION,
        rules: rules.to_vec(),
    }
}

pub(crate) fn render_document(document: &RulesDocument) -> String {
    let mut text = serde_json::to_string_pretty(document).unwrap_or_default();
    text.push('\n');
    text
}

pub(crate) fn parse_document(bytes: &[u8]) -> Result<RulesDocument, SharingError> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(SharingError::TooLarge);
    }
    let document: RulesDocument =
        serde_json::from_slice(bytes).map_err(|_| SharingError::Malformed)?;
    validate_document(&document)?;
    Ok(document)
}

pub(crate) fn validate_document(document: &RulesDocument) -> Result<(), SharingError> {
    if document.schema_version != SCHEMA_VERSION {
        return Err(SharingError::UnsupportedVersion(document.schema_version));
    }
    if document.rules.len() > MAX_RULES {
        return Err(SharingError::TooManyRules);
    }
    for (index, rule) in document.rules.iter().enumerate() {
        rule.validate()
            .map_err(|error| SharingError::InvalidRule(index + 1, error))?;
    }
    Ok(())
}

/// The rules as they would be saved: every imported rule asks first, and rules whose id is
/// already taken (or repeated in the file) get a fresh one. Existing rules come first.
pub(crate) fn merge_imported(
    existing: &[PipelineRule],
    imported: &[PipelineRule],
) -> Result<Vec<PipelineRule>, SharingError> {
    let mut merged = existing.to_vec();
    for rule in imported {
        let mut rule = rule.clone();
        rule.confirmation = Confirmation::Ask;
        if merged.iter().any(|other| other.rule_id == rule.rule_id) {
            rule.rule_id = fresh_rule_id(&merged);
        }
        merged.push(rule);
    }
    if merged.len() > MAX_RULES {
        return Err(SharingError::TooManyRules);
    }
    validate_rules(&merged).map_err(|error| SharingError::InvalidRule(merged.len(), error))?;
    Ok(merged)
}

fn fresh_rule_id(rules: &[PipelineRule]) -> String {
    (rules.len() + 1..)
        .map(|index| format!("r_{index:02}"))
        .find(|id| rules.iter().all(|rule| &rule.rule_id != id))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::pipeline::{tests::rule, PipelineTarget};

    fn document_text(rules: &[PipelineRule]) -> String {
        render_document(&export_document(rules))
    }

    #[test]
    fn exported_documents_parse_back_to_the_same_rules() {
        let rules = vec![rule()];
        let text = document_text(&rules);
        assert!(text.ends_with('\n'));
        assert!(text.contains("\"schemaVersion\": 1"));
        let parsed = parse_document(text.as_bytes()).unwrap();
        assert_eq!(parsed.rules, rules);
    }

    #[test]
    fn malformed_files_are_rejected() {
        for bad in [
            "",
            "not json",
            "[]",
            "{}",
            "{\"schemaVersion\":1}",
            "{\"schemaVersion\":1,\"rules\":[{\"ruleId\":\"x\"}]}",
            "{\"schemaVersion\":1,\"rules\":[],\"extra\":true}",
        ] {
            assert_eq!(
                parse_document(bad.as_bytes()),
                Err(SharingError::Malformed),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn unsupported_versions_oversized_files_and_too_many_rules_are_rejected() {
        let mut document = export_document(&[rule()]);
        document.schema_version = 2;
        assert_eq!(
            parse_document(render_document(&document).as_bytes()),
            Err(SharingError::UnsupportedVersion(2))
        );
        assert_eq!(
            parse_document(&vec![b' '; MAX_FILE_BYTES + 1]),
            Err(SharingError::TooLarge)
        );
        let many: Vec<PipelineRule> = (0..=MAX_RULES)
            .map(|index| {
                let mut r = rule();
                r.rule_id = format!("r_{index}");
                r
            })
            .collect();
        assert_eq!(
            parse_document(document_text(&many).as_bytes()),
            Err(SharingError::TooManyRules)
        );
    }

    #[test]
    fn invalid_rules_are_reported_with_their_position() {
        let mut bad = rule();
        bad.rule_id = "r_02".into();
        bad.targets.clear();
        let text = document_text(&[rule(), bad]);
        assert_eq!(
            parse_document(text.as_bytes()),
            Err(SharingError::InvalidRule(2, PipelineRuleError::NoTargets))
        );
    }

    #[test]
    fn imported_rules_always_ask_even_when_the_file_says_auto() {
        let mut automatic = rule();
        automatic.confirmation = Confirmation::Auto;
        let merged = merge_imported(&[], &[automatic]).unwrap();
        assert_eq!(merged[0].confirmation, Confirmation::Ask);
    }

    #[test]
    fn protected_targets_stay_asking_after_an_import() {
        let mut protected = rule();
        protected.confirmation = Confirmation::Auto;
        protected.targets = vec![PipelineTarget {
            branch: "main".into(),
            remote: "origin".into(),
        }];
        let merged = merge_imported(&[], &[protected]).unwrap();
        assert_eq!(merged[0].confirmation, Confirmation::Ask);
        assert!(merged[0].has_protected_target());
    }

    #[test]
    fn clashing_rule_ids_get_fresh_ones_and_existing_rules_stay_first() {
        let existing = vec![rule()];
        let merged = merge_imported(&existing, &[rule(), rule()]).unwrap();
        let ids: Vec<_> = merged.iter().map(|r| r.rule_id.as_str()).collect();
        assert_eq!(ids, ["r_01", "r_02", "r_03"]);
        assert_eq!(merged[0], existing[0]);
    }

    #[test]
    fn importing_past_the_rule_limit_is_refused() {
        let existing: Vec<PipelineRule> = (0..MAX_RULES)
            .map(|index| {
                let mut r = rule();
                r.rule_id = format!("e_{index}");
                r
            })
            .collect();
        assert_eq!(
            merge_imported(&existing, &[rule()]),
            Err(SharingError::TooManyRules)
        );
    }
}
