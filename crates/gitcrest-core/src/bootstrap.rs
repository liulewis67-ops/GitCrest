use std::{env, sync::Arc, time::Duration};

use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::time::timeout;

use crate::{
    api::router::app_router,
    config::AppConfig,
    events::publisher::EventBus,
    features::{
        credentials,
        repositories::{cloning::CloneService, repository::RepositoryManager},
        status::StatusService,
        tasks::TaskService,
    },
    git::{
        command::GitCommandService, refs::GitBranchAdapter, remote::GitRemoteAdapter,
        repository::GitRepositoryAdapter, tags::GitTagAdapter,
    },
    lifecycle::{readiness, shutdown},
    ports::branches::BranchGitPort,
    ports::git::RepositoryGitPort,
    ports::remotes::{
        RemoteCommandPort, RemoteGitPort, RemotePreflightReadPort, RemotePullRecoveryPort,
    },
    ports::tags::TagGitPort,
    refresh,
    state::AppState,
    storage::RepositoryStore,
};

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
    let remote_preflight_read: Arc<dyn RemotePreflightReadPort> = Arc::new(git_commands.clone());
    let remote_pull_recovery: Arc<dyn RemotePullRecoveryPort> = Arc::new(git_commands.clone());
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
    let state = AppState {
        read_write_token: Arc::new(config.write_token),
        read_only_token: config.read_only_token.map(Arc::new),
        conflict_token: config.conflict_token.map(Arc::new),
        shelf_store: Arc::new(store.clone()),
        undo_store: Arc::new(store.clone()),
        branch_favorites: Arc::new(store.clone()),
        ai_provider_settings: Arc::new(store.clone()),
        history_search_index: Arc::new(store),
        repositories: repositories.clone(),
        repository_targets,
        status: status.clone(),
        tasks,
        git_commands,
        tag_git,
        branch_git,
        remote_git,
        remote_commands,
        remote_preflight_read,
        remote_pull_recovery,
        clones,
        credentials: credentials::CredentialManager::system(),
        ai_credentials: credentials::AiCredentialManager::system(),
        events: events.clone(),
    };
    let app = app_router(state, config.cors_origin);

    let listener = TcpListener::bind(config.listen_address).await?;
    let address = listener.local_addr()?;
    let (shutdown_sender, shutdown_receiver) = watch::channel(false);
    let mut refresh_task = tokio::spawn(refresh::run(
        repositories,
        status,
        events,
        shutdown_receiver,
    ));
    readiness::announce(&config.listen_address.ip().to_string(), address);

    let server_shutdown = shutdown_sender.clone();
    let server_result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown::wait_for_shutdown().await;
            let _ = server_shutdown.send(true);
        })
        .await;
    let _ = shutdown_sender.send(true);
    match timeout(Duration::from_secs(5), &mut refresh_task).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("[gitcrest-core] Refresh watcher exited unexpectedly: {error}"),
        Err(_) => {
            refresh_task.abort();
            let _ = refresh_task.await;
            eprintln!("[gitcrest-core] Refresh watcher did not stop within 5 seconds");
        }
    }
    server_result?;
    Ok(())
}
