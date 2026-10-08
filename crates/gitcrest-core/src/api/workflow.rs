use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkflowOperationDto {
    Merge,
    CherryPick,
    Revert,
    Rebase,
    ShelfApply,
}

impl From<crate::domain::workflow::WorkflowOperation> for WorkflowOperationDto {
    fn from(operation: crate::domain::workflow::WorkflowOperation) -> Self {
        use crate::domain::workflow::WorkflowOperation;

        match operation {
            WorkflowOperation::Merge => Self::Merge,
            WorkflowOperation::CherryPick => Self::CherryPick,
            WorkflowOperation::Revert => Self::Revert,
            WorkflowOperation::Rebase => Self::Rebase,
            WorkflowOperation::ShelfApply => Self::ShelfApply,
        }
    }
}

impl From<WorkflowOperationDto> for crate::domain::workflow::WorkflowOperation {
    fn from(operation: WorkflowOperationDto) -> Self {
        use crate::domain::workflow::WorkflowOperation;

        match operation {
            WorkflowOperationDto::Merge => WorkflowOperation::Merge,
            WorkflowOperationDto::CherryPick => WorkflowOperation::CherryPick,
            WorkflowOperationDto::Revert => WorkflowOperation::Revert,
            WorkflowOperationDto::Rebase => WorkflowOperation::Rebase,
            WorkflowOperationDto::ShelfApply => WorkflowOperation::ShelfApply,
        }
    }
}
