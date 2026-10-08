use std::{env, net::SocketAddr, sync::Arc};

use axum::http::HeaderValue;
use serde::Serialize;
use tokio::net::TcpListener;

use crate::{
    api::router::app_router, cloning::CloneService, credentials, git_command::GitCommandService,
    repository::RepositoryManager, tasks::TaskService, watcher, AppState, EventBus,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyMessage<'a> {
    event: &'a str,
    host: &'a str,
    port: u16,
}

pub(crate) async fn run() -> i32 {
    if env::var_os("GITCREST_GIT_ASKPASS").as_deref() == Some(std::ffi::OsStr::new("1")) {
        return i32::from(run_git_askpass().is_err());
    }

    match run_server().await {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

fn run_git_askpass() -> Result<(), credentials::CredentialError> {
    use std::io::Write;

    if env::var_os("GITCREST_GIT_ASKPASS").as_deref() != Some(std::ffi::OsStr::new("1")) {
        return Err(credentials::CredentialError::InvalidInput);
    }
    let prompt = env::args_os()
        .nth(1)
        .and_then(|argument| argument.into_string().ok())
        .ok_or(credentials::CredentialError::InvalidInput)?;
    let response = credentials::answer_askpass_prompt(&prompt)?;
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(response.as_bytes())
        .and_then(|()| stdout.write_all(b"\n"))
        .and_then(|()| stdout.flush())
        .map_err(|_| credentials::CredentialError::Unavailable)
}

async fn run_server() -> Result<(), Box<dyn std::error::Error>> {
    let host = env::var("GITCREST_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("GITCREST_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    let write_token = env::var("GITCREST_AUTH_TOKEN")
        .map_err(|_| "GITCREST_AUTH_TOKEN is required to start gitcrest-core")?;
    let read_only_token = env::var("GITCREST_READONLY_TOKEN")
        .ok()
        .filter(|token| !token.is_empty());
    if read_only_token.as_deref() == Some(write_token.as_str()) {
        return Err("GITCREST_READONLY_TOKEN must differ from GITCREST_AUTH_TOKEN".into());
    }
    let conflict_token = env::var("GITCREST_CONFLICT_TOKEN")
        .ok()
        .filter(|token| !token.is_empty());
    if conflict_token.as_deref() == Some(write_token.as_str())
        || conflict_token.as_deref() == read_only_token.as_deref()
    {
        return Err("GITCREST_CONFLICT_TOKEN must be distinct from other API tokens".into());
    }

    let database_path = env::var_os("GITCREST_DATABASE_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(default_database_path);
    let repositories = RepositoryManager::open_database(database_path)
        .await
        .map_err(|_| "Could not initialize the repository database")?;
    let task_status_repositories = repositories.clone();
    let tasks =
        TaskService::with_store_and_status_invalidator(repositories.store(), move |repo_id| {
            task_status_repositories.invalidate_status(repo_id)
        })
        .map_err(|_| "Could not recover background task history")?;
    let git_commands = GitCommandService::default();
    let clones = CloneService::new(tasks.clone(), git_commands.clone(), repositories.clone());
    let events = EventBus::default();
    tokio::spawn(watcher::run(repositories.clone(), events.clone()));
    let state = AppState {
        read_write_token: Arc::new(write_token),
        read_only_token: read_only_token.map(Arc::new),
        conflict_token: conflict_token.map(Arc::new),
        repositories,
        tasks,
        git_commands,
        clones,
        credentials: credentials::CredentialManager::system(),
        ai_credentials: credentials::AiCredentialManager::system(),
        events,
    };
    let cors_origin = env::var("GITCREST_CORS_ORIGIN")
        .ok()
        .filter(|origin| !origin.is_empty())
        .map(|origin| origin.parse::<HeaderValue>())
        .transpose()?;
    let app = app_router(state, cors_origin);

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
    println!(
        "{}",
        serde_json::to_string(&message).expect("ready message serializes")
    );
}

fn default_database_path() -> std::path::PathBuf {
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        return std::path::PathBuf::from(local_app_data)
            .join("GitCrest")
            .join("gitcrest.sqlite");
    }
    if let Some(home) = env::var_os("HOME") {
        return std::path::PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("gitcrest")
            .join("gitcrest.sqlite");
    }
    env::temp_dir().join("gitcrest").join("gitcrest.sqlite")
}
