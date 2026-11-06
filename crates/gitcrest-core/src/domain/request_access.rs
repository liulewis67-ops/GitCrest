/// Assigned by bearer authentication, never deserialized from a request body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RequestAccess {
    ReadWrite,
    ReadOnly,
    ConflictOnly,
}

impl RequestAccess {
    pub fn allows_operation_actions(self) -> bool {
        self == Self::ReadWrite
    }
}
