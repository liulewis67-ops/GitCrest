use std::path::Path;

use crate::domain::{
    error::WorkflowError,
    workflow::{WorkflowBackupNamespace, WorkflowBackupReference, WorkflowRemoteBranchComparison},
};

use super::process::{run_git, text};

pub(crate) async fn list_backup_references(
    git_program: &str,
    repository_path: &Path,
    namespace: WorkflowBackupNamespace,
) -> Result<Vec<WorkflowBackupReference>, WorkflowError> {
    let references = match namespace {
        WorkflowBackupNamespace::Rebase => "refs/gitcrest/rebase-backups",
        WorkflowBackupNamespace::Reset => "refs/gitcrest/reset-backups",
    };
    let mut arguments = vec!["for-each-ref".into()];
    if namespace == WorkflowBackupNamespace::Reset {
        arguments.push("--count=1000".into());
    }
    arguments.push("--format=%(refname)%00%(objectname)%00%(subject)".into());
    arguments.push(references.into());
    let output = run_git(git_program, repository_path, &arguments).await?;
    let output = text(&output)?;
    output
        .lines()
        .map(|line| {
            let mut fields = line.splitn(3, '\0');
            Ok(WorkflowBackupReference {
                reference: fields.next().ok_or(WorkflowError::GitFailed)?.to_owned(),
                oid: fields.next().ok_or(WorkflowError::GitFailed)?.to_owned(),
                subject: fields.next().ok_or(WorkflowError::GitFailed)?.to_owned(),
            })
        })
        .collect()
}

pub(crate) async fn compare_remote_branch_delete(
    git_program: &str,
    repository_path: &Path,
    current_head_oid: Option<&str>,
    expected_remote_oid: &str,
) -> Result<WorkflowRemoteBranchComparison, WorkflowError> {
    let mut commits_only_on_remote = 0;
    let mut affected_paths = Vec::new();
    if let Some(head_oid) = current_head_oid {
        let count = run_git(
            git_program,
            repository_path,
            &[
                "rev-list".into(),
                "--count".into(),
                format!("{head_oid}..{expected_remote_oid}").into(),
            ],
        )
        .await?;
        commits_only_on_remote = text(&count)?
            .parse()
            .map_err(|_| WorkflowError::GitFailed)?;
        let paths = run_git(
            git_program,
            repository_path,
            &[
                "diff".into(),
                "--name-only".into(),
                "--no-renames".into(),
                "-z".into(),
                head_oid.into(),
                expected_remote_oid.into(),
            ],
        )
        .await?;
        affected_paths = paths
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect();
    }
    Ok(WorkflowRemoteBranchComparison {
        commits_only_on_remote,
        affected_paths,
    })
}
