mod api;
mod bootstrap;
mod config;
mod features;

mod domain;
mod git;
mod ports;
mod refresh;
mod state;
#[path = "storage/storage.rs"]
mod storage;

use features::tasks::{TaskFailure, TaskSnapshot};
use git::command::GitOperation;
use state::{AppState, EventBus};

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
