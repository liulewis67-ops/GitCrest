#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TaskFailure {
    Failed(String),
    Cancelled,
    WaitingForInput(String),
}
