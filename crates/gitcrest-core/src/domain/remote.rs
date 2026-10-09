#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteConfiguration {
    pub(crate) name: String,
    pub(crate) fetch_urls: Vec<String>,
    pub(crate) push_urls: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteConfigurationSnapshot {
    pub(crate) remotes: Vec<RemoteConfiguration>,
    pub(crate) configured_default: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteBranchUpstream {
    pub(crate) local_oid: String,
    pub(crate) remote_name: String,
    pub(crate) remote_ref: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RemoteBranchDivergence {
    pub(crate) ahead: u32,
    pub(crate) behind: u32,
}
