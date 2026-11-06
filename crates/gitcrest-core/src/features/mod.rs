pub(crate) mod accounts;
pub(crate) mod branches;
pub(crate) mod commits;
pub(crate) mod compare;
pub(crate) mod credentials;
pub(crate) mod diff;
pub(crate) mod history;
pub(crate) mod identity;
pub(crate) mod ignore;
#[allow(dead_code)] // internal previews; public operation creation remains disabled
pub(crate) mod operations;
#[allow(dead_code)] // wired to triggers and workspaces in A2.2 and A3.1
pub(crate) mod pipelines;
pub(crate) mod reflog;
pub(crate) mod remotes;
pub(crate) mod repositories;
pub(crate) mod settings;
pub(crate) mod shelves;
pub(crate) mod signing;
pub(crate) mod staging;
pub(crate) mod stash;
pub(crate) mod status;
pub(crate) mod submodules;
pub(crate) mod system;
pub(crate) mod tags;
pub(crate) mod tasks;
pub(crate) mod workflows;
