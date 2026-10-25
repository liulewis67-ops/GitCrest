use serde::{Deserialize, Serialize};

use super::service::{AccountSummary, DeviceFlowSnapshot, DeviceFlowStatus};
use crate::{
    api::error::{ApiError, ApiErrorDetails},
    domain::account::HostingProvider,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TokenSignInRequest {
    pub(super) provider: HostingProvider,
    pub(super) host: String,
    pub(super) token: zeroize::Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeviceFlowRequest {
    pub(super) provider: HostingProvider,
    pub(super) host: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceFlowResponse {
    flow_id: String,
    provider: HostingProvider,
    host: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_at_ms: i64,
    status: &'static str,
    /// The signed-in account once the flow completed.
    account: Option<AccountSummary>,
    /// Why a failed flow failed.
    error: Option<ApiErrorDetails>,
}

impl From<DeviceFlowSnapshot> for DeviceFlowResponse {
    fn from(flow: DeviceFlowSnapshot) -> Self {
        let status = flow.status.as_str();
        let (account, error) = match flow.status {
            DeviceFlowStatus::Completed(account) => (Some(account), None),
            DeviceFlowStatus::Failed(error) => (
                None,
                Some(ApiError::from_account_error(error).into_details()),
            ),
            DeviceFlowStatus::Pending | DeviceFlowStatus::Denied | DeviceFlowStatus::Expired => {
                (None, None)
            }
        };
        Self {
            flow_id: flow.flow_id,
            provider: flow.provider,
            host: flow.host,
            user_code: flow.user_code,
            verification_uri: flow.verification_uri,
            verification_uri_complete: flow.verification_uri_complete,
            expires_at_ms: flow.expires_at_ms,
            status,
            account,
            error,
        }
    }
}
