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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorkflowActionDto {
    Merge,
    CherryPick,
    Revert,
}

impl From<crate::domain::workflow::WorkflowAction> for WorkflowActionDto {
    fn from(action: crate::domain::workflow::WorkflowAction) -> Self {
        use crate::domain::workflow::WorkflowAction;

        match action {
            WorkflowAction::Merge => Self::Merge,
            WorkflowAction::CherryPick => Self::CherryPick,
            WorkflowAction::Revert => Self::Revert,
        }
    }
}

impl From<WorkflowActionDto> for crate::domain::workflow::WorkflowAction {
    fn from(action: WorkflowActionDto) -> Self {
        use crate::domain::workflow::WorkflowAction;

        match action {
            WorkflowActionDto::Merge => WorkflowAction::Merge,
            WorkflowActionDto::CherryPick => WorkflowAction::CherryPick,
            WorkflowActionDto::Revert => WorkflowAction::Revert,
        }
    }
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
