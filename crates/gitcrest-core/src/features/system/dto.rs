use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VersionResponse<'a> {
    pub(super) name: &'a str,
    pub(super) version: &'a str,
    pub(super) api_version: u8,
}

/// Whether the Git LFS extension is available, so a pointer file can be explained.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LfsStatus {
    pub(super) installed: bool,
    /// The first line of `git lfs version`, such as `git-lfs/3.5.1 (...)`.
    pub(super) version: Option<String>,
}
