#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BranchReference {
    pub(crate) full_name: String,
    pub(crate) name: String,
    pub(crate) oid: String,
    pub(crate) upstream: Option<String>,
    pub(crate) upstream_gone: bool,
    pub(crate) ahead: Option<u32>,
    pub(crate) behind: Option<u32>,
}
