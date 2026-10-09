use std::path::Path;

use super::{
    nonempty, run_git, text, HistoryError, RefSnapshot, RepositoryRef, MAX_HISTORY_OUTPUT,
};

pub async fn read_refs(
    repo_id: String,
    repository_path: &Path,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
) -> Result<RefSnapshot, HistoryError> {
    let output = run_git(
        repository_path,
        &[
            "for-each-ref".into(),
            "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)".into(),
            "refs/heads".into(),
            "refs/remotes".into(),
        ],
        MAX_HISTORY_OUTPUT,
    )
    .await?;
    let mut refs = Vec::new();
    for record in output
        .split(|byte| *byte == b'\n')
        .filter(|record| !record.is_empty())
    {
        let fields = record.splitn(4, |byte| *byte == 0).collect::<Vec<_>>();
        if fields.len() != 4 {
            return Err(HistoryError::GitFailed);
        }
        let full_name = text(fields[0]);
        let name = text(fields[1]);
        let oid = text(fields[2]);
        let upstream = nonempty(text(fields[3]));
        let kind = if full_name.starts_with("refs/heads/") {
            "local"
        } else {
            "remote"
        };
        refs.push(RepositoryRef {
            name,
            full_name,
            oid,
            kind: kind.into(),
            upstream,
        });
    }
    Ok(RefSnapshot {
        repo_id,
        head,
        branch,
        detached,
        refs,
    })
}
