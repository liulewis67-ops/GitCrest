use super::envelope::EventEnvelope;

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
