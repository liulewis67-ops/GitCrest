use std::collections::HashMap;

pub(crate) trait BranchActivityStorePort: Send + Sync {
    fn branch_activity(&self, resource_key: &str) -> Result<HashMap<String, i64>, String>;
    fn record_branch_activity(
        &self,
        resource_key: &str,
        full_names: &[String],
        at_ms: i64,
    ) -> Result<(), String>;
}
