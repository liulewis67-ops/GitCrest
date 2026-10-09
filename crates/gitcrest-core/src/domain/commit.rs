#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CommitSearchEntry {
    pub(crate) oid: String,
    pub(crate) parents: Vec<String>,
    pub(crate) author_name: String,
    pub(crate) author_email: String,
    pub(crate) committed_at_ms: i64,
    pub(crate) subject: String,
    pub(crate) message: String,
    pub(crate) sort_order: usize,
}
