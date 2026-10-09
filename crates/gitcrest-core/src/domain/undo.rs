use super::{diff::DiffScope, shelf::ShelfSnapshot};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UndoRecord {
    pub operation_task_id: String,
    pub repo_id: String,
    pub created_at_ms: i64,
    pub reverse_patch: Vec<u8>,
    pub operation: UndoOperation,
    pub restore_shelf: Option<ShelfSnapshot>,
    pub restore_shelf_patch: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UndoOperation {
    Staging,
    ShelfApply { scope: DiffScope },
    WorkspaceDiscard,
}
