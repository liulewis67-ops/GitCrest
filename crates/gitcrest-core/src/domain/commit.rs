#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CommitSearchEntry {
    pub(crate) oid: String,
    pub(crate) message: String,
}
