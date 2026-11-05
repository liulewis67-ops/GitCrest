pub(crate) mod accounts;
pub(crate) mod branch_favorites;
pub(crate) mod branches;
pub(crate) mod cloning;
pub(crate) mod conflicts;
pub(crate) mod diff;
pub(crate) mod git;
pub(crate) mod history;
#[allow(dead_code)] // internal durable recovery dispatch
pub(crate) mod operation_actions;
#[allow(dead_code)] // internal journal; consumed by preservation orchestration
pub(crate) mod operations;
#[allow(dead_code)] // consumed by the run engine in A2.1
pub(crate) mod pipelines;
pub(crate) mod remotes;
pub(crate) mod repository;
pub(crate) mod settings;
pub(crate) mod shelves;
pub(crate) mod status;
pub(crate) mod tags;
pub(crate) mod tasks;
pub(crate) mod undo;
