#[derive(Clone, Debug)]
pub(crate) enum RemoteCommand {
    Add {
        name: String,
        url: String,
    },
    SetUrl {
        name: String,
        url: String,
    },
    Remove {
        name: String,
        next_default: Option<String>,
    },
    SetDefault {
        name: String,
    },
    SetUpstream {
        local_branch: String,
        remote_name: String,
        remote_branch: String,
    },
}

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteBranchCommit {
    pub(crate) oid: String,
    pub(crate) subject: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteBranchDeleteCommand {
    pub(crate) remote_name: String,
    pub(crate) remote_branch: String,
    pub(crate) target_ref: String,
    pub(crate) expected_remote_oid: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemotePullCommand {
    pub(crate) repo_id: String,
    pub(crate) local_branch: String,
    pub(crate) remote_name: String,
    pub(crate) remote_branch: String,
    pub(crate) local_oid: String,
    pub(crate) tracking_oid: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RemotePullStrategy {
    Merge,
    Rebase,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemotePushCommand {
    pub(crate) local_branch: String,
    pub(crate) remote_name: String,
    pub(crate) remote_branch: String,
    pub(crate) local_oid: String,
    pub(crate) expected_remote_oid: String,
}
