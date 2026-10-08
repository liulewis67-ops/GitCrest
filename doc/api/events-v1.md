# GitCrest event protocol v1

The WebSocket endpoint is `GET /api/v1/events`. The client must authenticate the HTTP upgrade with `Authorization: Bearer <session-token>`. The token is never put in the URL, WebSocket subprotocol, or event body. Electron clients must use a privileged transport that can attach the authorization header; do not open this endpoint directly with Chromium's `WebSocket` constructor.

The main window token has `read` and `write` capability. Diff and other inspection windows receive a separate `read`-only token. Every write endpoint checks capability on the Rust side; hiding controls in a renderer is not an authorization boundary.

Each successful connection begins with `connection.resyncRequired`. Events are in-memory notifications, not a durable event log. On first connection, reconnect, or a sequence gap, the client must fetch the repository list and then fetch the complete current snapshot for the selected repository (repository, status, refs/log state used by the current view) before treating the UI as synchronized. Do not replay guessed state from events received before a disconnect. `eventId` can detect gaps within one running connection but is not a resume cursor.

All messages use the EventEnvelope schema in v1.yaml and protocolVersion 1. eventId starts at 1 and increases for each event delivered on that connection; a gap requires a full resync. occurredAtMs is a Unix timestamp in milliseconds.

status.changed includes repoId and a payload with full, paths, and reasons. When full is false and paths are present, the client can request GET /api/v1/repositories/{repoId}/status?paths=... for those literal relative scopes and merge the result into its last complete snapshot. Rename, ignore-rule, index, HEAD, or watcher recovery events request a full status snapshot. If a refresh is already in flight, queue the new scopes and apply them after the current request; do not discard them.

repository.updated signals that repository metadata needs refreshing. log.refsChanged signals that branch/ref-backed history views need refreshing. Unknown event types must be ignored after recording that a full snapshot is needed. The server rejects unsupported API major versions with HTTP 406 and API_VERSION_UNSUPPORTED; incompatible event protocol versions are closed with WebSocket code 1002.
