use axum::{http::StatusCode, response::IntoResponse, Json};

use super::dto::VersionResponse;

pub(super) async fn health() -> impl IntoResponse {
    (StatusCode::NO_CONTENT, [("Cache-Control", "no-store")])
}

pub(super) async fn version() -> impl IntoResponse {
    Json(VersionResponse {
        name: "gitcrest-core",
        version: env!("CARGO_PKG_VERSION"),
        api_version: 1,
    })
}

/// `git lfs version` succeeds only when the extension is installed; the answer is never an error.
pub(super) async fn lfs_status() -> Json<super::dto::LfsStatus> {
    use std::{process::Stdio, time::Duration};

    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("git")
            .args(["lfs", "version"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let version = match output {
        Ok(Ok(output)) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .map(|line| line.trim().chars().take(200).collect::<String>())
            .filter(|line| !line.is_empty()),
        _ => None,
    };
    Json(super::dto::LfsStatus {
        installed: version.is_some(),
        version,
    })
}
