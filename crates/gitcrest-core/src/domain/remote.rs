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
    pub(crate) local_branch: String,
    pub(crate) remote_name: String,
    pub(crate) remote_branch: String,
    pub(crate) local_oid: String,
    pub(crate) tracking_oid: String,
}

pub(crate) fn is_remote_name_syntactically_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.chars().any(char::is_control)
        && !name.starts_with('-')
}

pub(crate) fn is_safe_remote_url(remote: &str) -> bool {
    if remote.is_empty()
        || remote.len() > 2_048
        || remote
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || remote.starts_with('-')
    {
        return false;
    }
    let lower = remote.to_ascii_lowercase();
    let allowed = lower.starts_with("https://")
        || lower.starts_with("ssh://")
        || (cfg!(test) && lower.starts_with("file://"))
        || is_scp_style_remote(remote);
    if !allowed
        || remote.contains(['?', '#'])
        || lower.contains("access_token=")
        || lower.contains("?token=")
        || lower.contains("&token=")
        || lower.contains("password=")
    {
        return false;
    }
    if lower.starts_with("https://") {
        let authority = remote[8..]
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default();
        if authority.contains('@') {
            return false;
        }
    }
    if lower.starts_with("ssh://") {
        let authority = remote[6..]
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default();
        if authority
            .split_once('@')
            .is_some_and(|(user, _)| user.contains(':'))
        {
            return false;
        }
    }
    true
}

fn is_scp_style_remote(remote: &str) -> bool {
    let Some((user, host_path)) = remote.split_once('@') else {
        return false;
    };
    !user.is_empty()
        && !user.contains(':')
        && host_path.contains(':')
        && !host_path.starts_with(':')
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemotePullState {
    pub(crate) local_oid: String,
    pub(crate) remote_name: String,
    pub(crate) remote_branch: String,
    pub(crate) tracking_oid: String,
    pub(crate) is_clean: bool,
    pub(crate) has_conflicts: bool,
    pub(crate) operation_in_progress: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PullRecoveryDecision {
    Cancelled,
    WaitForInput,
    VerifyMergeResult,
    OutcomeUnknown,
}

pub(crate) fn assess_cancelled_pull(
    expected: &RemotePullCommand,
    current: &RemotePullState,
) -> PullRecoveryDecision {
    if current.local_oid != expected.local_oid || current.tracking_oid != expected.tracking_oid {
        PullRecoveryDecision::OutcomeUnknown
    } else if current.operation_in_progress {
        PullRecoveryDecision::WaitForInput
    } else if current.has_conflicts {
        PullRecoveryDecision::OutcomeUnknown
    } else if current.is_clean {
        PullRecoveryDecision::Cancelled
    } else {
        PullRecoveryDecision::VerifyMergeResult
    }
}

pub(crate) fn pull_state_restored(expected: &RemotePullCommand, current: &RemotePullState) -> bool {
    current.local_oid == expected.local_oid
        && current.tracking_oid == expected.tracking_oid
        && !current.operation_in_progress
        && !current.has_conflicts
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
