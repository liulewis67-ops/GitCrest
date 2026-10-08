#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RebaseAction {
    Pick,
    Reword,
    Edit,
    Squash,
    Fixup,
    Drop,
}

impl RebaseAction {
    pub(crate) fn git_keyword(self) -> &'static str {
        match self {
            Self::Pick | Self::Reword => "pick",
            Self::Edit => "edit",
            Self::Squash => "squash",
            Self::Fixup => "fixup",
            Self::Drop => "drop",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RebaseTodoItem {
    pub(crate) oid: String,
    pub(crate) action: RebaseAction,
    pub(crate) message: Option<String>,
}
