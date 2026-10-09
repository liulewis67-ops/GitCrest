mod api;
mod bootstrap;
mod config;
mod credentials;
mod features;

mod domain;
mod events;
mod execution;
mod git;
mod ports;
mod refresh;
mod state;
mod storage;

pub(crate) use events::publisher::EventBus;
use execution::TaskFailure;
use features::tasks::TaskSnapshot;
use state::AppState;

#[cfg(test)]
use axum::{http::StatusCode, response::IntoResponse};
#[cfg(test)]
async fn write_probe() -> impl IntoResponse {
    StatusCode::NO_CONTENT
}

pub async fn run() -> i32 {
    bootstrap::run().await
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
