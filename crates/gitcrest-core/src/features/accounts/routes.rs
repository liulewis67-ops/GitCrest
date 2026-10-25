use axum::{
    routing::{delete, get, post},
    Router,
};

use crate::state::AppState;

use super::handlers::{
    cancel_device_flow, get_device_flow, list_accounts, select_account, sign_in_with_token,
    sign_out, start_device_flow, validate_account,
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/accounts", get(list_accounts))
        .route("/v1/accounts/tokens", post(sign_in_with_token))
        .route("/v1/accounts/device-flows", post(start_device_flow))
        .route(
            "/v1/accounts/device-flows/:flow_id",
            get(get_device_flow).delete(cancel_device_flow),
        )
        .route("/v1/accounts/:account_id", delete(sign_out))
        .route("/v1/accounts/:account_id/select", post(select_account))
        .route("/v1/accounts/:account_id/validate", post(validate_account))
}
