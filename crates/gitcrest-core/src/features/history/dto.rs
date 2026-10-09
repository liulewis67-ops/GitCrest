use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HistoryQuery {
    pub(super) offset: Option<usize>,
    pub(super) limit: Option<usize>,
    pub(super) sha: Option<String>,
    pub(super) author: Option<String>,
    pub(super) message: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) path: Option<String>,
    pub(super) since: Option<String>,
    pub(super) until: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BlameQuery {
    pub(super) path: String,
    pub(super) revision: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommitPageDto {
    repo_id: String,
    offset: usize,
    limit: usize,
    commits: Vec<CommitSummaryDto>,
    next_offset: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitSummaryDto {
    oid: String,
    parents: Vec<String>,
    author_name: String,
    author_email: String,
    committed_at_ms: i64,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommitDetailDto {
    repo_id: String,
    oid: String,
    parents: Vec<String>,
    author_name: String,
    author_email: String,
    committed_at_ms: i64,
    message: String,
    stats: CommitStatsDto,
    files: Vec<CommitFileStatDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitStatsDto {
    files_changed: usize,
    insertions: u64,
    deletions: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitFileStatDto {
    path: String,
    additions: Option<u64>,
    deletions: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BlameDocumentDto {
    repo_id: String,
    path: String,
    revision: Option<String>,
    lines: Vec<BlameLineDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlameLineDto {
    line_number: u32,
    original_line_number: u32,
    commit_oid: String,
    author_name: String,
    author_email: String,
    committed_at_ms: i64,
    summary: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RefSnapshotDto {
    repo_id: String,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    refs: Vec<RepositoryRefDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryRefDto {
    name: String,
    full_name: String,
    oid: String,
    kind: String,
    upstream: Option<String>,
}

impl From<super::model::CommitPage> for CommitPageDto {
    fn from(page: super::model::CommitPage) -> Self {
        Self {
            repo_id: page.repo_id,
            offset: page.offset,
            limit: page.limit,
            commits: page.commits.into_iter().map(Into::into).collect(),
            next_offset: page.next_offset,
        }
    }
}

impl From<super::model::CommitSummary> for CommitSummaryDto {
    fn from(summary: super::model::CommitSummary) -> Self {
        Self {
            oid: summary.oid,
            parents: summary.parents,
            author_name: summary.author_name,
            author_email: summary.author_email,
            committed_at_ms: summary.committed_at_ms,
            subject: summary.subject,
        }
    }
}

impl From<super::model::CommitDetail> for CommitDetailDto {
    fn from(detail: super::model::CommitDetail) -> Self {
        Self {
            repo_id: detail.repo_id,
            oid: detail.oid,
            parents: detail.parents,
            author_name: detail.author_name,
            author_email: detail.author_email,
            committed_at_ms: detail.committed_at_ms,
            message: detail.message,
            stats: CommitStatsDto {
                files_changed: detail.stats.files_changed,
                insertions: detail.stats.insertions,
                deletions: detail.stats.deletions,
            },
            files: detail
                .files
                .into_iter()
                .map(|file| CommitFileStatDto {
                    path: file.path,
                    additions: file.additions,
                    deletions: file.deletions,
                })
                .collect(),
        }
    }
}

impl From<super::model::BlameDocument> for BlameDocumentDto {
    fn from(document: super::model::BlameDocument) -> Self {
        Self {
            repo_id: document.repo_id,
            path: document.path,
            revision: document.revision,
            lines: document
                .lines
                .into_iter()
                .map(|line| BlameLineDto {
                    line_number: line.line_number,
                    original_line_number: line.original_line_number,
                    commit_oid: line.commit_oid,
                    author_name: line.author_name,
                    author_email: line.author_email,
                    committed_at_ms: line.committed_at_ms,
                    summary: line.summary,
                    text: line.text,
                })
                .collect(),
        }
    }
}

impl From<super::model::RefSnapshot> for RefSnapshotDto {
    fn from(snapshot: super::model::RefSnapshot) -> Self {
        Self {
            repo_id: snapshot.repo_id,
            head: snapshot.head,
            branch: snapshot.branch,
            detached: snapshot.detached,
            refs: snapshot
                .refs
                .into_iter()
                .map(|reference| RepositoryRefDto {
                    name: reference.name,
                    full_name: reference.full_name,
                    oid: reference.oid,
                    kind: reference.kind,
                    upstream: reference.upstream,
                })
                .collect(),
        }
    }
}
