use std::{env, net::SocketAddr, sync::Arc};

use serde::Serialize;
use tokio::net::TcpListener;

use crate::{
    api::router::app_router,
    config::AppConfig,
    features::{
        credentials,
        repositories::{cloning::CloneService, repository::RepositoryManager},
        status::StatusService,
        tasks::TaskService,
    },
    git::{
        command::GitCommandService, refs::GitBranchAdapter, remotes::GitRemoteAdapter,
        repository::GitRepositoryAdapter, tags::GitTagAdapter,
    },
    ports::branches::BranchGitPort,
    ports::git::RepositoryGitPort,
    ports::remotes::{RemoteCommandPort, RemoteGitPort},
    ports::tags::TagGitPort,
    refresh,
    state::{AppState, EventBus},
    storage::RepositoryStore,
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
    let config = AppConfig::from_env()?;
    let database_path = config.database_path;
    let store = tokio::task::spawn_blocking(move || RepositoryStore::open(&database_path))
        .await
        .map_err(|_| "Could not initialize the repository database")?
        .map_err(|_| "Could not initialize the repository database")?;
    let repository_catalog: Arc<dyn crate::ports::repository::RepositoryCatalogPort> =
        Arc::new(store.clone());
    let repository_git: Arc<dyn RepositoryGitPort> = Arc::new(GitRepositoryAdapter);
    let repositories =
        RepositoryManager::with_adapters(repository_catalog.clone(), repository_git.clone());
    let repository_targets = crate::features::repositories::RepositoryTargetReader::new(
        repository_catalog,
        repository_git,
    );
    let git_commands = GitCommandService::default();
    let remote_commands: Arc<dyn RemoteCommandPort> = Arc::new(git_commands.clone());
    let tag_git: Arc<dyn TagGitPort> = Arc::new(GitTagAdapter);
    let branch_git: Arc<dyn BranchGitPort> = Arc::new(GitBranchAdapter);
    let remote_git: Arc<dyn RemoteGitPort> = Arc::new(GitRemoteAdapter);
    let status = StatusService::with_reader(repository_targets.clone(), git_commands.clone());
    let task_status = status.clone();
    let tasks =
        TaskService::with_store_and_status_invalidator(Arc::new(store.clone()), move |repo_id| {
            task_status.invalidate(repo_id)
        })
        .map_err(|_| "Could not recover background task history")?;
    let clones = CloneService::new(tasks.clone(), git_commands.clone(), repositories.clone());
    let events = EventBus::default();
    tokio::spawn(refresh::run(
        repositories.clone(),
        status.clone(),
        events.clone(),
    ));
    let state = AppState {
        read_write_token: Arc::new(config.write_token),
        read_only_token: config.read_only_token.map(Arc::new),
        conflict_token: config.conflict_token.map(Arc::new),
        shelf_store: Arc::new(store.clone()),
        undo_store: Arc::new(store.clone()),
        branch_favorites: Arc::new(store.clone()),
        ai_provider_settings: Arc::new(store.clone()),
        history_search_index: Arc::new(store),
        repositories,
        repository_targets,
        status,
        tasks,
        git_commands,
        tag_git,
        branch_git,
        remote_git,
        remote_commands,
        clones,
        credentials: credentials::CredentialManager::system(),
        ai_credentials: credentials::AiCredentialManager::system(),
        events,
    };
    let app = app_router(state, config.cors_origin);

    let listener = TcpListener::bind(config.listen_address).await?;
    let address = listener.local_addr()?;
    announce_ready(&config.listen_address.ip().to_string(), address);

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
