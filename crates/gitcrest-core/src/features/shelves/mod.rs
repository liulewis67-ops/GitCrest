#[path = "shelves.rs"]
mod service;

mod handlers;
pub(crate) mod routes;

pub(crate) use handlers::load_shelf_record;
pub(crate) use service::*;
