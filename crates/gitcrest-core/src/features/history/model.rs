#[derive(Clone, Debug)]
pub(crate) struct CommitPage {
    pub repo_id: String,
    pub offset: usize,
    pub limit: usize,
    pub commits: Vec<CommitSummary>,
    pub next_offset: Option<usize>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct HistoryFilters {
    pub sha: Option<String>,
    pub author: Option<String>,
    pub message: Option<String>,
    pub branch: Option<String>,
    pub path: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct CommitSummary {
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub committed_at_ms: i64,
    pub subject: String,
}

#[derive(Clone, Debug)]
pub(crate) struct CommitDetail {
    pub repo_id: String,
    pub oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub committed_at_ms: i64,
    pub message: String,
    pub stats: CommitStats,
    pub files: Vec<CommitFileStat>,
}

#[derive(Clone, Debug)]
pub(crate) struct CommitStats {
    pub files_changed: usize,
    pub insertions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct CommitFileStat {
    pub path: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

#[derive(Clone, Debug)]
pub(crate) struct BlameDocument {
    pub repo_id: String,
    pub path: String,
    pub revision: Option<String>,
    pub lines: Vec<BlameLine>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BlameLine {
    pub line_number: u32,
    pub original_line_number: u32,
    pub commit_oid: String,
    pub author_name: String,
    pub author_email: String,
    pub committed_at_ms: i64,
    pub summary: String,
    pub text: String,
}

#[derive(Clone, Debug)]
pub(crate) struct RefSnapshot {
    pub repo_id: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub refs: Vec<RepositoryRef>,
}

#[derive(Clone, Debug)]
pub(crate) struct RepositoryRef {
    pub name: String,
    pub full_name: String,
    pub oid: String,
    pub kind: String,
    pub upstream: Option<String>,
}
