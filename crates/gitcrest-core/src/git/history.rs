use std::path::Path;

use tokio::{sync::Semaphore, task::JoinSet};

use crate::domain::{
    error::WorkflowError,
    workflow::{WorkflowCommitSubject, WorkflowRebaseCommitList, WorkflowResetComparison},
};

use super::process::{run_git, run_git_optional, text};

const MAX_REBASE_COMMITS: usize = 200;

pub(crate) async fn compare_for_reset(
    git_program: &str,
    repository_path: &Path,
    head_oid: &str,
    target_oid: &str,
) -> Result<WorkflowResetComparison, WorkflowError> {
    let counts = run_git(
        git_program,
        repository_path,
        &[
            "rev-list".into(),
            "--left-right".into(),
            "--count".into(),
            format!("{head_oid}...{target_oid}").into(),
        ],
    )
    .await?;
    let (commits_removed, commits_added) = text(&counts)?
        .split_once('\t')
        .and_then(|(left, right)| Some((left.parse().ok()?, right.parse().ok()?)))
        .ok_or(WorkflowError::GitFailed)?;
    let paths = run_git(
        git_program,
        repository_path,
        &[
            "diff".into(),
            "--name-only".into(),
            "--no-renames".into(),
            format!("{head_oid}..{target_oid}").into(),
            "--".into(),
        ],
    )
    .await?;
    let changed_paths = text(&paths)?
        .lines()
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect();
    Ok(WorkflowResetComparison {
        commits_removed,
        commits_added,
        changed_paths,
    })
}

pub(crate) async fn list_rebase_commits(
    git_program: &str,
    repository_path: &Path,
    onto_oid: &str,
    head_oid: &str,
) -> Result<WorkflowRebaseCommitList, WorkflowError> {
    let range = format!("{onto_oid}..{head_oid}");
    let output = run_git(
        git_program,
        repository_path,
        &[
            "log".into(),
            "--reverse".into(),
            "--topo-order".into(),
            "--format=%H%x00%s".into(),
            "-n".into(),
            (MAX_REBASE_COMMITS + 1).to_string().into(),
            "--no-show-signature".into(),
            range.into(),
        ],
    )
    .await?;
    let mut commits = Vec::new();
    let mut omitted_commit_count = 0;
    for line in text(&output)?.lines().filter(|line| !line.is_empty()) {
        let (oid, subject) = line.split_once('\0').ok_or(WorkflowError::GitFailed)?;
        if commits.len() == MAX_REBASE_COMMITS {
            omitted_commit_count += 1;
            continue;
        }
        commits.push(WorkflowCommitSubject {
            oid: oid.trim().to_owned(),
            subject: subject.trim().to_owned(),
        });
    }

    let mut checks = JoinSet::new();
    let semaphore = std::sync::Arc::new(Semaphore::new(8));
    for commit in &commits {
        let oid = commit.oid.clone();
        let path = repository_path.to_path_buf();
        let semaphore = semaphore.clone();
        let git_program = git_program.to_owned();
        checks.spawn(async move {
            let permit = semaphore
                .acquire_owned()
                .await
                .map_err(|_| WorkflowError::GitFailed)?;
            let refs = run_git(
                &git_program,
                &path,
                &[
                    "for-each-ref".into(),
                    "--format=%(refname)".into(),
                    "--contains".into(),
                    oid.clone().into(),
                    "refs/remotes".into(),
                ],
            )
            .await;
            drop(permit);
            refs.and_then(|refs| text(&refs).map(|refs| (oid, !refs.is_empty())))
        });
    }
    let mut published_commit_oids = Vec::new();
    while let Some(result) = checks.join_next().await {
        let (oid, is_published) = result.map_err(|_| WorkflowError::GitFailed)??;
        if is_published {
            published_commit_oids.push(oid);
        }
    }
    published_commit_oids.sort();
    Ok(WorkflowRebaseCommitList {
        commits,
        omitted_commit_count,
        published_commit_oids,
    })
}

pub(crate) async fn resolve_commit_target(
    git_program: &str,
    repository_path: &Path,
    target: &str,
) -> Result<String, WorkflowError> {
    let output = run_git(
        git_program,
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "--end-of-options".into(),
            format!("{target}^{{commit}}").into(),
        ],
    )
    .await?;
    Ok(text(&output)?.to_owned())
}

pub(crate) async fn read_commit_subject(
    git_program: &str,
    repository_path: &Path,
    target_oid: &str,
) -> Result<String, WorkflowError> {
    let output = run_git(
        git_program,
        repository_path,
        &[
            "show".into(),
            "-s".into(),
            "--format=%s".into(),
            target_oid.into(),
        ],
    )
    .await?;
    Ok(text(&output)?.to_owned())
}

pub(crate) async fn read_head_oid(
    git_program: &str,
    repository_path: &Path,
) -> Result<Option<String>, WorkflowError> {
    run_git_optional(
        git_program,
        repository_path,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "HEAD^{commit}".into(),
        ],
    )
    .await?
    .as_deref()
    .map(text)
    .transpose()
    .map(|head| head.map(str::to_owned))
}

pub(crate) async fn read_current_branch(
    git_program: &str,
    repository_path: &Path,
) -> Result<Option<String>, WorkflowError> {
    run_git_optional(
        git_program,
        repository_path,
        &[
            "symbolic-ref".into(),
            "--quiet".into(),
            "--short".into(),
            "HEAD".into(),
        ],
    )
    .await?
    .as_deref()
    .map(text)
    .transpose()
    .map(|branch| branch.map(str::to_owned))
}
