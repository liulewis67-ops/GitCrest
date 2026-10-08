use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

use super::error::{ApiError, ApiErrorCode};
use crate::{state::EventEnvelope, AppState};

pub(crate) async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let protocols = headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !protocols
        .split(',')
        .any(|protocol| protocol.trim() == "gitcrest.events.v1")
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            ApiErrorCode::RequestInvalid,
            "The gitcrest.events.v1 WebSocket subprotocol is required.",
        ));
    }

    Ok(ws
        .protocols(["gitcrest.events.v1"])
        .on_upgrade(move |socket| event_socket(socket, state.events.subscribe()))
        .into_response())
}

// Sending the owned ping payload in the guard avoids cloning it before the async send.
#[allow(clippy::collapsible_match)]
async fn event_socket(
    mut socket: WebSocket,
    mut events: tokio::sync::broadcast::Receiver<EventEnvelope>,
) {
    let mut event_sequence = 1_u64;
    if send_event(
        &mut socket,
        EventEnvelope::new(
            None,
            "connection.resyncRequired",
            serde_json::json!({ "reason": "newConnection" }),
        ),
        &mut event_sequence,
    )
    .await
    .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => if send_event(&mut socket, event, &mut event_sequence).await.is_err() { break; },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let event = EventEnvelope::new(
                        None,
                        "connection.resyncRequired",
                        serde_json::json!({ "reason": "eventBacklogExceeded" }),
                    );
                    if send_event(&mut socket, event, &mut event_sequence).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            message = socket.recv() => match message {
                Some(Ok(Message::Ping(payload))) => {
                    if socket.send(Message::Pong(payload)).await.is_err() { break; }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    }
}

async fn send_event(
    socket: &mut WebSocket,
    mut event: EventEnvelope,
    event_sequence: &mut u64,
) -> Result<(), axum::Error> {
    event.event_id = event_sequence.to_string();
    *event_sequence = event_sequence.saturating_add(1);
    if let Ok(message) = serde_json::to_string(&event) {
        socket.send(Message::Text(message)).await
    } else {
        Ok(())
    }
}
