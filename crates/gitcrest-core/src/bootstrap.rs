use std::{env, sync::Arc, time::Duration};

use tokio::net::TcpListener;
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
    let mut shutdown = shutdown::Shutdown::listen();
    let config = AppConfig::from_env()?;
    if shutdown.is_requested() {
        return Ok(());
    }
    let database_path = config.database_path;
    let pipeline_data_dir = database_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default();
    let ai_providers =
        crate::storage::settings::JsonAiProviderStore::beside_database(&database_path);
    let display_path = database_path.display().to_string();
    // The cause and path reach the startup error the desktop app shows, so a locked, unwritable or
    // damaged database can be told apart.
    let store = tokio::task::spawn_blocking(move || RepositoryStore::open(&database_path))
        .await
        .map_err(|_| format!("Could not initialize the repository database at {display_path}"))?
        .map_err(|error| {
            format!("Could not initialize the repository database at {display_path}: {error}")
        })?;
    if shutdown.is_requested() {
        return Ok(());
    }
    let ephemeral_contexts =
        Arc::new(crate::features::pipelines::ephemeral::EphemeralContexts::default());
    let repository_catalog: Arc<dyn crate::ports::repository::RepositoryCatalogPort> = Arc::new(
        crate::features::pipelines::ephemeral::EphemeralAwareCatalog::new(
            Arc::new(store.clone()),
            ephemeral_contexts.clone(),
        ),
    );
    let repository_git: Arc<dyn RepositoryGitPort> = Arc::new(GitRepositoryAdapter);
    let repository_filesystem: Arc<dyn crate::ports::repository::RepositoryFilesystemPort> =
        Arc::new(crate::storage::repository_paths::RepositoryFilesystemAdapter);
    let clone_filesystem: Arc<dyn crate::ports::cloning::CloneFilesystemPort> =
        Arc::new(crate::storage::cloning::CloneFilesystemAdapter);
    let diff_worktree: Arc<dyn crate::ports::diff::DiffWorktreePort> =
        Arc::new(crate::storage::diff::DiffWorktreeAdapter);
    let repositories = RepositoryManager::with_adapters(
        repository_catalog.clone(),
        repository_git.clone(),
        repository_filesystem.clone(),
    );
    let repository_targets = crate::features::repositories::RepositoryTargetReader::new(
        repository_catalog.clone(),
        repository_git,
        repository_filesystem.clone(),
    )
    .with_ephemeral_contexts(ephemeral_contexts.clone());
    let account_selections = crate::credentials::AccountSelections::default();
    let git_commands =
        GitCommandService::default().with_account_selections(account_selections.clone());
    let remote_preflight_read: Arc<dyn RemotePreflightReadPort> = Arc::new(git_commands.clone());
    let remote_pull_recovery: Arc<dyn RemotePullRecoveryPort> = Arc::new(git_commands.clone());
    let remote_commands: Arc<dyn RemoteCommandPort> = Arc::new(git_commands.clone());
    let tag_git: Arc<dyn TagGitPort> = Arc::new(GitTagAdapter);
    let branch_git: Arc<dyn BranchGitPort> = Arc::new(GitBranchAdapter);
    let remote_git: Arc<dyn RemoteGitPort> = Arc::new(GitRemoteAdapter);
    let status = StatusService::with_reader(repository_targets.clone(), git_commands.clone());
    let task_status = status.clone();
    let write_access = crate::execution::write_access::WriteAccess::new(
        Arc::new(repository_targets.clone()),
        Arc::new(store.clone()),
    );
    write_access
        .recover_interrupted()
        .await
        .map_err(|_| "Could not verify durable repository operation ownership")?;
    let action_store = store.clone();
    tokio::task::spawn_blocking(move || {
        crate::ports::operation_actions::OperationActionStorePort::recover_interrupted_actions(
            &action_store,
        )
    })
    .await
    .map_err(|_| "Could not inspect interrupted operation actions")?
    .map_err(|_| "Could not classify interrupted operation actions")?;
    let tasks =
        TaskService::with_store_and_status_invalidator(Arc::new(store.clone()), move |repo_id| {
            task_status.invalidate(repo_id)
        })
        .map_err(|_| "Could not recover background task history")?
        .with_write_access(write_access)
        .with_branch_activity(Arc::new(store.clone()));
    shutdown.watch_tasks(tasks.clone());
    tasks.start_retention_cleanup();
    if shutdown.is_requested() {
        tasks.begin_shutdown().await;
        tasks.drain_workers(Duration::from_secs(5)).await;
        return Ok(());
    }
    let clones = CloneService::new(
        tasks.clone(),
        git_commands.clone(),
        repositories.clone(),
        clone_filesystem,
    );
    let events = EventBus::default();
    let accounts = crate::features::accounts::AccountService::new(
        Arc::new(store.clone()),
        credentials::system_account_secret_store(),
        Arc::new(crate::features::accounts::providers::HttpHostingProviderClient),
        account_selections.clone(),
    )
    .with_oauth_apps(crate::features::accounts::providers::OAuthApps::from_environment())
    .with_events(events.clone());
    account_selections.set_token_refresher(Arc::new(accounts.clone()));
    tasks.observe_authentication_failures({
        let accounts = accounts.clone();
        move |output| accounts.authentication_failed(output)
    });
    // A durable operation moves HEAD and the branch outside the ordinary branch tasks, so refresh the stored
    // repository record before its task is reported finished; readers of that record stay current.
    tasks.observe_operation_finished({
        let repositories = repositories.clone();
        move |repo_id| {
            let repositories = repositories.clone();
            Box::pin(async move {
                let _ = repositories.refresh_metadata(&repo_id).await;
            })
        }
    });
    let state = AppState {
        read_write_token: Arc::new(config.write_token),
        read_only_token: config.read_only_token.map(Arc::new),
        conflict_token: config.conflict_token.map(Arc::new),
        shelf_store: Arc::new(store.clone()),
        operation_queries: crate::features::operations::query::OperationQueryService {
            store: Arc::new(store.clone()),
        },
        operation_actions: crate::features::operations::actions::OperationActionService::assemble(
            store.clone(),
            repository_targets.clone(),
            git_commands.clone(),
        ),
        operation_creation: config.operation_creation_enabled.then(|| {
            crate::features::operations::creation::OperationCreationService {
                actions: crate::features::operations::actions::OperationActionService::assemble(
                    store.clone(),
                    repository_targets.clone(),
                    git_commands.clone(),
                ),
            }
        }),
        shelf_patch_checker: Arc::new(git_commands.clone()),
        conflict_worktree: Arc::new(crate::storage::conflicts::ConflictWorktreeAdapter),
        diff_worktree,
        undo_store: Arc::new(store.clone()),
        branch_favorites: Arc::new(store.clone()),
        pipeline_store: Arc::new(store.clone()),
        pipelines: Arc::new(crate::features::pipelines::service::PipelineService::new(
            Arc::new(store.clone()),
            repository_catalog,
            ephemeral_contexts,
            events.clone(),
            pipeline_data_dir,
            tasks.clone(),
            repository_targets.clone(),
            git_commands.clone(),
        )),
        ai_providers: Arc::new(ai_providers),
        history_search_index: Arc::new(store),
        repositories: repositories.clone(),
        repository_targets,
        status: status.clone(),
        tasks: tasks.clone(),
        git_commands,
        tag_git,
        branch_git,
        remote_git,
        remote_commands,
        remote_preflight_read,
        remote_pull_recovery,
        clones,
        credentials: credentials::CredentialManager::system(),
        accounts,
        events: events.clone(),
    };
    // Unfinished pipeline runs are looked at before triggers can start new ones.
    state.pipelines.recover_on_startup().await;
    if shutdown.is_requested() {
        tasks.begin_shutdown().await;
        tasks.drain_workers(Duration::from_secs(5)).await;
        return Ok(());
    }
    let admission = Arc::new(tokio::sync::RwLock::new(()));
    shutdown.allow_idle_recovery(tasks.clone(), admission.clone());
    let request_admission = admission.clone();
    let request_shutdown = shutdown.subscribe();
    let app = app_router(state, config.cors_origin).layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let admission = request_admission.clone();
            let shutdown = request_shutdown.clone();
            async move {
                use axum::http::{Method, StatusCode};
                use axum::response::IntoResponse;
                let Ok(gate) = admission.try_read_owned() else {
                    return StatusCode::SERVICE_UNAVAILABLE.into_response();
                };
                if *shutdown.borrow() {
                    return StatusCode::SERVICE_UNAVAILABLE.into_response();
                }
                if matches!(
                    *request.method(),
                    Method::GET | Method::HEAD | Method::OPTIONS
                ) {
                    return next.run(request).await;
                }
                // Keep write admission held until the handler finishes even if Chromium disconnects.
                tokio::spawn(async move {
                    let _gate = gate;
                    next.run(request).await
                })
                .await
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
            }
        },
    ));

    let listener = TcpListener::bind(config.listen_address).await?;
    let address = listener.local_addr()?;
    if shutdown.is_requested() {
        tasks.begin_shutdown().await;
        tasks.drain_workers(Duration::from_secs(5)).await;
        return Ok(());
    }
    let shutdown_receiver = shutdown.subscribe();
    let mut refresh_task = tokio::spawn(refresh::run(
        repositories,
        status,
        events,
        shutdown_receiver,
    ));
    let announced = shutdown
        .publish_if_open(|| readiness::announce(&config.listen_address.ip().to_string(), address));
    let server_result = if announced {
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown::wait(shutdown.subscribe()))
            .await
    } else {
        Ok(())
    };
    shutdown.request();
    tasks.begin_shutdown().await;
    // Detached request handlers still hold admission if their HTTP client disconnected.
    let _request_drain = admission.write().await;
    let refresh_drain = async {
        match timeout(Duration::from_secs(5), &mut refresh_task).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                eprintln!("[gitcrest-core] Refresh watcher exited unexpectedly: {error}")
            }
            Err(_) => {
                refresh_task.abort();
                let _ = refresh_task.await;
                eprintln!("[gitcrest-core] Refresh watcher did not stop within 5 seconds");
            }
        }
    };
    let task_drain = tasks.drain_workers(Duration::from_secs(5));
    let _ = tokio::join!(refresh_drain, task_drain);
    server_result?;
    Ok(())
}
