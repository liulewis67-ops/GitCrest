#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConflictError {
    InvalidPath,
    NotConflicted,
    FileNotFound,
    TooLarge,
    Binary,
    GitUnavailable,
    GitFailed,
    TimedOut,
    Io,
    StaleRevision,
    UnresolvedMarkers,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WorkflowError {
    InvalidTarget,
    CommitNotFound,
    NoActiveOperation,
    GitUnavailable,
    TimedOut,
    TooLarge,
    GitFailed,
}
