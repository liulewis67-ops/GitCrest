#[path = "ai.rs"]
mod service;

mod dto;
mod handlers;
pub(crate) mod routes;

pub(crate) use dto::*;
pub(crate) use handlers::get_ai_settings;
pub(crate) use service::*;
