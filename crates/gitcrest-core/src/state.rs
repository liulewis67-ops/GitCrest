use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{
    features::{
        credentials,
        repositories::{
            cloning::CloneService, repository::RepositoryManager, RepositoryTargetReader,
        },
        status::StatusService,
        tasks::TaskService,
    },
    git::command::GitCommandService,
};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) read_write_token: Arc<String>,
    pub(crate) read_only_token: Option<Arc<String>>,
    pub(crate) conflict_token: Option<Arc<String>>,
    pub(crate) repositories: RepositoryManager,
    pub(crate) repository_targets: RepositoryTargetReader,
    pub(crate) status: StatusService<RepositoryTargetReader, GitCommandService>,
    pub(crate) tasks: TaskService,
    pub(crate) git_commands: GitCommandService,
    pub(crate) clones: CloneService,
    pub(crate) credentials: credentials::CredentialManager,
    pub(crate) ai_credentials: credentials::AiCredentialManager,
    pub(crate) events: EventBus,
}

#[derive(Clone)]
pub(crate) struct EventBus(tokio::sync::broadcast::Sender<EventEnvelope>);

impl Default for EventBus {
    fn default() -> Self {
        let (sender, _) = tokio::sync::broadcast::channel(512);
        Self(sender)
    }
}

impl EventBus {
    pub(crate) fn subscribe(&self) -> tokio::sync::broadcast::Receiver<EventEnvelope> {
        self.0.subscribe()
    }

    pub(crate) fn publish(
        &self,
        repo_id: Option<String>,
        event_type: &str,
        payload: serde_json::Value,
    ) {
        let event = EventEnvelope::new(repo_id, event_type, payload);
        let _ = self.0.send(event);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventEnvelope {
    pub(crate) event_id: String,
    pub(crate) protocol_version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repo_id: Option<String>,
    #[serde(rename = "type")]
    pub(crate) event_type: String,
    pub(crate) occurred_at_ms: u128,
    pub(crate) payload: serde_json::Value,
}

impl EventEnvelope {
    pub(crate) fn new(
        repo_id: Option<String>,
        event_type: &str,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            event_id: String::new(),
            protocol_version: 1,
            repo_id,
            event_type: event_type.to_owned(),
            occurred_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            payload,
        }
    }
}
