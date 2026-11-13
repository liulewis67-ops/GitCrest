use std::sync::Arc;

use crate::{
    events::publisher::EventBus,
    features::{
        credentials,
        repositories::{
            cloning::CloneService, repository::RepositoryManager, RepositoryTargetReader,
        },
        status::StatusService,
        tasks::TaskService,
    },
    git::command::GitCommandService,
    ports::branch_favorites::BranchFavoriteStorePort,
    ports::branches::BranchGitPort,
    ports::history::HistorySearchIndexPort,
    ports::pipelines::PipelineStorePort,
    ports::remotes::{
        RemoteCommandPort, RemoteGitPort, RemotePreflightReadPort, RemotePullRecoveryPort,
    },
    ports::settings::AiProviderConfigPort,
    ports::tags::TagGitPort,
    ports::undo::UndoStorePort,
    ports::{
        conflicts::ConflictWorktreePort,
        diff::DiffWorktreePort,
        shelves::{ShelfPatchCheckPort, ShelfStorePort},
    },
};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) read_write_token: Arc<String>,
    pub(crate) read_only_token: Option<Arc<String>>,
    pub(crate) conflict_token: Option<Arc<String>>,
    pub(crate) repositories: RepositoryManager,
    pub(crate) branch_favorites: Arc<dyn BranchFavoriteStorePort>,
    pub(crate) pipeline_store: Arc<dyn PipelineStorePort>,
    pub(crate) pipelines: Arc<crate::features::pipelines::service::PipelineService>,
    pub(crate) branch_git: Arc<dyn BranchGitPort>,
    pub(crate) remote_git: Arc<dyn RemoteGitPort>,
    pub(crate) remote_commands: Arc<dyn RemoteCommandPort>,
    pub(crate) remote_preflight_read: Arc<dyn RemotePreflightReadPort>,
    pub(crate) remote_pull_recovery: Arc<dyn RemotePullRecoveryPort>,
    pub(crate) ai_providers: Arc<dyn AiProviderConfigPort>,
    pub(crate) history_search_index: Arc<dyn HistorySearchIndexPort>,
    pub(crate) shelf_store: Arc<dyn ShelfStorePort>,
    pub(crate) operation_queries: crate::features::operations::query::OperationQueryService,
    pub(crate) operation_actions: crate::features::operations::actions::OperationActionService,
    /// None while the creation rollout flag is off.
    pub(crate) operation_creation:
        Option<crate::features::operations::creation::OperationCreationService>,
    pub(crate) shelf_patch_checker: Arc<dyn ShelfPatchCheckPort>,
    pub(crate) conflict_worktree: Arc<dyn ConflictWorktreePort>,
    pub(crate) diff_worktree: Arc<dyn DiffWorktreePort>,
    pub(crate) undo_store: Arc<dyn UndoStorePort>,
    pub(crate) repository_targets: RepositoryTargetReader,
    pub(crate) status: StatusService<RepositoryTargetReader, GitCommandService>,
    pub(crate) tasks: TaskService,
    pub(crate) git_commands: GitCommandService,
    pub(crate) tag_git: Arc<dyn TagGitPort>,
    pub(crate) clones: CloneService,
    pub(crate) credentials: credentials::CredentialManager,
    pub(crate) accounts: crate::features::accounts::AccountService,
    pub(crate) events: EventBus,
}
