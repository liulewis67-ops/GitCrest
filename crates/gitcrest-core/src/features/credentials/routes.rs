use axum::{routing::get, Router};

use crate::state::AppState;

use super::handlers::{delete_credential, get_credential_status, set_credential};

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/v1/credentials",
        get(get_credential_status)
            .put(set_credential)
            .delete(delete_credential),
    )
}
