pub(crate) mod account;
pub(crate) mod ai;
pub(crate) mod branch;
pub(crate) mod commit;
pub(crate) mod diff;
pub(crate) mod error;
#[allow(dead_code)] // shared result types; command adapters are wired separately
pub(crate) mod git_result;
#[allow(dead_code)] // internal journal; creation stays disabled until recovery is available
pub(crate) mod operation;
#[allow(dead_code)] // internal recovery action dispatch remains gated
pub(crate) mod operation_action;
#[allow(dead_code)] // consumed by the run engine in A2.1
pub(crate) mod pipeline;
pub(crate) mod remote;
pub(crate) mod repository;
pub(crate) mod shelf;
pub(crate) mod staging;
pub(crate) mod status;
pub(crate) mod task;
pub(crate) mod time;
pub(crate) mod undo;
pub(crate) mod workflow;
