use super::diff::DiffScope;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShelfSnapshot {
    pub shelf_id: String,
    pub repo_id: String,
    pub name: String,
    pub description: String,
    pub paths: Vec<String>,
    pub scope: Option<DiffScope>,
    pub head_oid: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShelfRecord {
    pub snapshot: ShelfSnapshot,
    pub patch: Vec<u8>,
}
