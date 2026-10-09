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
