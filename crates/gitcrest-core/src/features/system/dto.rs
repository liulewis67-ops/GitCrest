use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VersionResponse<'a> {
    pub(super) name: &'a str,
    pub(super) version: &'a str,
    pub(super) api_version: u8,
}
