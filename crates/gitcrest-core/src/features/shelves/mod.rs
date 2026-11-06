#[allow(dead_code)] // internal evidence reader; public operation execution remains disabled
pub(crate) mod evidence;
pub(crate) mod journal;
#[allow(dead_code)] // internal save-group executor; public operations remain disabled
pub(crate) mod operation_save;
#[allow(dead_code)] // internal full-scope preflight; public operation API remains disabled
pub(crate) mod planning;
pub(crate) mod preparation;
pub(crate) mod restoration;
pub(crate) mod saving;
mod service;

mod dto;
mod handlers;
pub(crate) mod routes;

pub(crate) use service::*;
