#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepositoryRecord {
    pub(crate) repo_id: String,
    pub(crate) path: String,
    pub(crate) head: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) detached: bool,
    pub(crate) state: String,
    pub(crate) is_favorite: bool,
    pub(crate) last_accessed_at: i64,
    pub(crate) availability: String,
}
