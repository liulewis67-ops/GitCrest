use std::{env, net::SocketAddr, sync::Arc};

use axum::{
    body::Body,
    extract::State,
    http::{header::AUTHORIZATION, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use tokio::net::TcpListener;

#[derive(Clone)]
struct AppState {
    token: Arc<String>,
}

#[derive(Serialize)]
struct ReadyMessage<'a> {
    event: &'a str,
    host: &'a str,
    port: u16,
}

#[derive(Serialize)]
struct VersionResponse<'a> {
    name: &'a str,
    version: &'a str,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let host = env::var("GITCREST_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("GITCREST_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    let token = env::var("GITCREST_AUTH_TOKEN")
        .map_err(|_| "GITCREST_AUTH_TOKEN is required to start gitcrest-core")?;

    let state = AppState {
        token: Arc::new(token),
    };

    let api = Router::new()
        .route("/version", get(version))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    let app = Router::new()
        .route("/health", get(health))
        .nest("/api", api)
        .with_state(state);

    let listener = TcpListener::bind((host.as_str(), port)).await?;
    let address = listener.local_addr()?;
    announce_ready(&host, address);

    axum::serve(listener, app).await?;
    Ok(())
}

fn announce_ready(host: &str, address: SocketAddr) {
    let message = ReadyMessage {
        event: "ready",
        host,
        port: address.port(),
    };

    println!("{}", serde_json::to_string(&message).expect("ready message serializes"));
}

async fn health() -> impl IntoResponse {
    StatusCode::NO_CONTENT
}

async fn version() -> impl IntoResponse {
    Json(VersionResponse {
        name: "gitcrest-core",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn require_auth(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let expected = format!("Bearer {}", state.token);
    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value == expected)
        .unwrap_or(false);

    if !authorized {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(request).await)
}
