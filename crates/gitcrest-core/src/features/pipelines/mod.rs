mod dto;
#[allow(dead_code)] // consumed by the run API in A3.1
pub(crate) mod engine;
pub(crate) mod ephemeral;
mod gitops;
mod handlers;
pub(crate) mod inplace;
#[cfg(test)]
mod inplace_tests;
#[cfg(test)]
mod recovery_tests;
pub(crate) mod routes;
pub(crate) mod service;
#[cfg(test)]
mod service_tests;
#[allow(dead_code)] // consumed by the run API in A3.1
pub(crate) mod workspace;
#[allow(dead_code)] // consumed by the run API in A3.1
pub(crate) mod worktree;
#[cfg(test)]
mod worktree_tests;
