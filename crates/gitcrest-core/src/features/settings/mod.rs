#[path = "ai.rs"]
mod service;

mod handlers;
pub(crate) mod routes;

pub(crate) use handlers::get_ai_settings;
pub(crate) use service::*;
