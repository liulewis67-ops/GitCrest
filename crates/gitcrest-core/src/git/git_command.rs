use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::ExitStatus,
    time::Duration,
};

use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::watch,
    task::JoinHandle,
    time::Instant,
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::staging::StagingCommand;
use crate::tasks::{TaskContext, TaskFailure};
use crate::{
    domain::{
        error::WorkflowError,
        workflow::{
            WorkflowBackupNamespace, WorkflowBackupReference, WorkflowRebaseCommitList,
            WorkflowRemoteBranchComparison, WorkflowResetComparison, WorkflowState,
        },
    },
    ports::workflow_git::WorkflowGitPort,
};

#[path = "workflow_state.rs"]
pub(crate) mod workflow_state;

const GIT_EXECUTION_DEADLINE: Duration = Duration::from_secs(2 * 60 * 60);
const GIT_NETWORK_NO_PROGRESS_DEADLINE: Duration = Duration::from_secs(5 * 60);
const MAX_CAPTURED_STAGING_PATCH_BYTES: usize = 20 * 1024 * 1024;
static NEXT_TEMP_INDEX: AtomicU64 = AtomicU64::new(1);
static NEXT_TEMP_REBASE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitOperation {
    Fetch,
    FetchPrune,
}

#[derive(Clone, Debug)]
pub enum BranchCommand {
    Create { name: String },
    Switch { name: String },
    Rename { old_name: String, new_name: String },
    Delete { name: String, allow_unmerged: bool },
}

#[derive(Clone, Debug)]
pub enum RemoteCommand {
    Add {
        name: String,
        url: String,
    },
    SetUrl {
        name: String,
        url: String,
    },
    Remove {
        name: String,
        next_default: Option<String>,
    },
    SetDefault {
        name: String,
    },
    SetUpstream {
        local_branch: String,
        remote_name: String,
        remote_branch: String,
    },
}

impl GitOperation {
    fn arguments(self) -> &'static [&'static str] {
        match self {
            Self::Fetch => &["fetch", "--progress"],
            Self::FetchPrune => &["fetch", "--progress", "--prune"],
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Fetch => "Fetch",
            Self::FetchPrune => "Fetch and prune",
        }
    }
}

#[derive(Clone, Debug)]
pub struct GitCommandService {
    git_program: String,
}

impl Default for GitCommandService {
    fn default() -> Self {
        Self {
            git_program: "git".into(),
        }
    }
}

impl WorkflowGitPort for GitCommandService {
    async fn resolve_commit_target(
        &self,
        repository_path: &Path,
        target: &str,
    ) -> Result<String, WorkflowError> {
        workflow_state::resolve_commit_target(&self.git_program, repository_path, target).await
    }

    async fn read_commit_subject(
        &self,
        repository_path: &Path,
        target_oid: &str,
    ) -> Result<String, WorkflowError> {
        workflow_state::read_commit_subject(&self.git_program, repository_path, target_oid).await
    }

    async fn read_head_oid(&self, repository_path: &Path) -> Result<Option<String>, WorkflowError> {
        workflow_state::read_head_oid(&self.git_program, repository_path).await
    }

    async fn read_current_branch(
        &self,
        repository_path: &Path,
    ) -> Result<Option<String>, WorkflowError> {
        workflow_state::read_current_branch(&self.git_program, repository_path).await
    }

    async fn read_worktree_state(
        &self,
        repository_path: &Path,
    ) -> Result<WorkflowState, WorkflowError> {
        workflow_state::read_worktree_state(&self.git_program, repository_path).await
    }

    async fn read_operation(
        &self,
        repository_path: &Path,
    ) -> Result<Option<crate::domain::workflow::WorkflowOperation>, WorkflowError> {
        workflow_state::read_operation(&self.git_program, repository_path).await
    }

    async fn list_backup_references(
        &self,
        repository_path: &Path,
        namespace: WorkflowBackupNamespace,
    ) -> Result<Vec<WorkflowBackupReference>, WorkflowError> {
        workflow_state::list_backup_references(&self.git_program, repository_path, namespace).await
    }

    async fn compare_for_reset(
        &self,
        repository_path: &Path,
        head_oid: &str,
        target_oid: &str,
    ) -> Result<WorkflowResetComparison, WorkflowError> {
        workflow_state::compare_for_reset(&self.git_program, repository_path, head_oid, target_oid)
            .await
    }

    async fn list_rebase_commits(
        &self,
        repository_path: &Path,
        onto_oid: &str,
        head_oid: &str,
    ) -> Result<WorkflowRebaseCommitList, WorkflowError> {
        workflow_state::list_rebase_commits(&self.git_program, repository_path, onto_oid, head_oid)
            .await
    }

    async fn compare_remote_branch_delete(
        &self,
        repository_path: &Path,
        current_head_oid: Option<&str>,
        expected_remote_oid: &str,
    ) -> Result<WorkflowRemoteBranchComparison, WorkflowError> {
        workflow_state::compare_remote_branch_delete(
            &self.git_program,
            repository_path,
            current_head_oid,
            expected_remote_oid,
        )
        .await
    }
}

impl GitCommandService {
    #[allow(dead_code)]
    pub fn with_program(git_program: impl Into<String>) -> Self {
        Self {
            git_program: git_program.into(),
        }
    }

    pub async fn read_index_tree(&self, repository_path: &Path) -> Result<String, TaskFailure> {
        let output =
            capture_git_output(&self.git_program, repository_path, ["write-tree"], 128).await?;
        let oid = String::from_utf8(output)
            .map_err(|_| TaskFailure::Failed("Git returned an invalid index tree ID".into()))?;
        let oid = oid.trim();
        if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(TaskFailure::Failed(
                "Git returned an invalid index tree ID".into(),
            ));
        }
        Ok(oid.to_ascii_lowercase())
    }

    pub async fn diff_index_trees(
        &self,
        repository_path: &Path,
        before_tree: &str,
        after_tree: &str,
    ) -> Result<Vec<u8>, TaskFailure> {
        for oid in [before_tree, after_tree] {
            if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(TaskFailure::Failed(
                    "Git returned an invalid index tree ID".into(),
                ));
            }
        }
        capture_git_output(
            &self.git_program,
            repository_path,
            [
                "diff",
                "--binary",
                "--no-ext-diff",
                "--no-renames",
                before_tree,
                after_tree,
            ],
            MAX_CAPTURED_STAGING_PATCH_BYTES,
        )
        .await
    }

    pub async fn diff_index_trees_for_paths(
        &self,
        repository_path: &Path,
        before_tree: &str,
        after_tree: &str,
        paths: &[String],
    ) -> Result<Vec<u8>, TaskFailure> {
        validate_tree_ids(&[before_tree, after_tree])?;
        let mut arguments = vec![
            "diff".into(),
            "--binary".into(),
            "--no-ext-diff".into(),
            "--no-renames".into(),
            before_tree.into(),
            after_tree.into(),
            "--".into(),
        ];
        arguments.extend(paths.iter().map(OsString::from));
        capture_git_output_args(
            &self.git_program,
            repository_path,
            arguments,
            MAX_CAPTURED_STAGING_PATCH_BYTES,
        )
        .await
    }

    pub async fn diff_tree_to_worktree_paths(
        &self,
        repository_path: &Path,
        before_tree: &str,
        paths: &[String],
    ) -> Result<Vec<u8>, TaskFailure> {
        validate_tree_ids(&[before_tree])?;
        let mut arguments = vec![
            "diff".into(),
            "--binary".into(),
            "--no-ext-diff".into(),
            "--no-renames".into(),
            before_tree.into(),
            "--".into(),
        ];
        arguments.extend(paths.iter().map(OsString::from));
        capture_git_output_args(
            &self.git_program,
            repository_path,
            arguments,
            MAX_CAPTURED_STAGING_PATCH_BYTES,
        )
        .await
    }

    pub async fn execute(
        &self,
        repository_path: &Path,
        operation: GitOperation,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let environment = askpass_environment()?;
        run_command(
            &self.git_program,
            operation.arguments().iter().map(OsString::from).collect(),
            None,
            None,
            Vec::new(),
            environment,
            Some(repository_path),
            operation.label(),
            task,
        )
        .await
    }

    pub async fn execute_pull(
        &self,
        repository_path: &Path,
        expected: &crate::remotes::pull::PullPreflight,
        strategy: crate::remotes::pull::PullStrategy,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let current = crate::remotes::pull::read_pull_preflight(
            expected.repo_id.clone(),
            repository_path,
            Some(&expected.local_branch),
            false,
        )
        .await
        .map_err(|_| {
            TaskFailure::Failed(
                "Pull preflight could not be revalidated. Refresh and review the repository state."
                    .into(),
            )
        })?;
        if current.local_oid != expected.local_oid
            || current.tracking_oid != expected.tracking_oid
            || current.remote_name != expected.remote_name
            || current.remote_branch != expected.remote_branch
            || !current.is_clean
        {
            return Err(TaskFailure::Failed(
                "Pull preflight became stale or the worktree is no longer clean. Review repository state before pulling.".into(),
            ));
        }
        let strategy_flag = match strategy {
            crate::remotes::pull::PullStrategy::Merge => "--no-rebase",
            crate::remotes::pull::PullStrategy::Rebase => "--rebase",
        };
        let result = run_command(
            &self.git_program,
            vec![
                "pull".into(),
                "--progress".into(),
                "--no-edit".into(),
                strategy_flag.into(),
                "--".into(),
                expected.remote_name.clone().into(),
                expected.remote_branch.clone().into(),
            ],
            Some(match strategy {
                crate::remotes::pull::PullStrategy::Merge => {
                    format!("pull --no-rebase {}", expected.remote_name)
                }
                crate::remotes::pull::PullStrategy::Rebase => {
                    format!("pull --rebase {}", expected.remote_name)
                }
            }),
            None,
            Vec::new(),
            askpass_environment()?,
            Some(repository_path),
            match strategy {
                crate::remotes::pull::PullStrategy::Merge => "Pull with merge",
                crate::remotes::pull::PullStrategy::Rebase => "Pull with rebase",
            },
            task,
        )
        .await;
        if strategy == crate::remotes::pull::PullStrategy::Rebase
            && matches!(&result, Err(TaskFailure::Cancelled))
        {
            return self
                .reconcile_cancelled_pull_rebase(repository_path, expected)
                .await;
        }
        let result = workflow_command_result(&self.git_program, repository_path, result).await;
        if matches!(&result, Err(TaskFailure::Cancelled)) {
            return self
                .reconcile_cancelled_pull(repository_path, expected)
                .await;
        }
        result
    }

    async fn reconcile_cancelled_pull_rebase(
        &self,
        repository_path: &Path,
        expected: &crate::remotes::pull::PullPreflight,
    ) -> Result<(), TaskFailure> {
        match workflow_state::read_operation(&self.git_program, repository_path).await {
            Ok(Some(crate::domain::workflow::WorkflowOperation::Rebase)) => {
                let rebase_apply = capture_git_output(
                    &self.git_program,
                    repository_path,
                    ["rev-parse", "--git-path", "rebase-apply"],
                    4096,
                )
                .await
                .ok()
                .and_then(|output| String::from_utf8(output).ok())
                .map(|path| PathBuf::from(path.trim()))
                .map(|path| {
                    if path.is_absolute() {
                        path
                    } else {
                        repository_path.join(path)
                    }
                });
                if rebase_apply.is_some_and(|path| path.is_dir()) {
                    capture_git_output_args(
                        &self.git_program,
                        repository_path,
                        vec!["am".into(), "--abort".into()],
                        1024,
                    )
                    .await
                    .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
                } else {
                    let status = capture_git_output(
                        &self.git_program,
                        repository_path,
                        ["status", "--porcelain=v1", "--untracked-files=all"],
                        2 * 1024 * 1024,
                    )
                    .await
                    .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
                    if !status.is_empty() {
                        return Err(TaskFailure::WaitingForInput(
                            "Pull rebase was cancelled while user changes remain in the worktree. Review the changes before aborting the rebase.".into(),
                        ));
                    }
                    capture_git_output_args(
                        &self.git_program,
                        repository_path,
                        vec!["rebase".into(), "--abort".into()],
                        1024,
                    )
                    .await
                    .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
                }

                let branch_ref = format!("refs/heads/{}", expected.local_branch);
                let branch_oid = capture_git_output_args(
                    &self.git_program,
                    repository_path,
                    vec!["rev-parse".into(), "--verify".into(), branch_ref.into()],
                    1024,
                )
                .await
                .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
                if std::str::from_utf8(&branch_oid).ok().map(str::trim)
                    != Some(expected.local_oid.as_str())
                {
                    return Err(TaskFailure::Failed(pull_cancel_outcome_unknown()));
                }

                let current_branch = capture_git_output(
                    &self.git_program,
                    repository_path,
                    ["branch", "--show-current"],
                    1024,
                )
                .await
                .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
                if std::str::from_utf8(&current_branch).ok().map(str::trim)
                    != Some(expected.local_branch.as_str())
                {
                    capture_git_output_args(
                        &self.git_program,
                        repository_path,
                        vec!["switch".into(), "--".into(), expected.local_branch.clone().into()],
                        1024,
                    )
                    .await
                    .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
                }

                let restored = crate::remotes::pull::read_pull_preflight(
                    expected.repo_id.clone(),
                    repository_path,
                    Some(&expected.local_branch),
                    false,
                )
                .await
                .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
                if restored.local_oid == expected.local_oid
                    && restored.tracking_oid == expected.tracking_oid
                    && !restored.operation_in_progress
                    && !restored.has_conflicts
                {
                    Err(TaskFailure::Cancelled)
                } else {
                    Err(TaskFailure::Failed(pull_cancel_outcome_unknown()))
                }
            }
            Ok(Some(_)) => Err(TaskFailure::WaitingForInput(
                "Pull rebase was cancelled while another Git operation remains active. Review repository state before continuing.".into(),
            )),
            Ok(None) => self.reconcile_cancelled_pull(repository_path, expected).await,
            Err(_) => Err(TaskFailure::Failed(pull_cancel_outcome_unknown())),
        }
    }

    async fn reconcile_cancelled_pull(
        &self,
        repository_path: &Path,
        expected: &crate::remotes::pull::PullPreflight,
    ) -> Result<(), TaskFailure> {
        let snapshot = crate::remotes::pull::read_pull_preflight(
            expected.repo_id.clone(),
            repository_path,
            Some(&expected.local_branch),
            false,
        )
        .await
        .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
        if snapshot.local_oid != expected.local_oid
            || snapshot.tracking_oid != expected.tracking_oid
        {
            return Err(TaskFailure::Failed(pull_cancel_outcome_unknown()));
        }
        if snapshot.operation_in_progress {
            return Err(TaskFailure::WaitingForInput(
                "Pull was cancelled while a Git operation remains active. Continue or abort it from Task Center.".into(),
            ));
        }
        if snapshot.has_conflicts {
            return Err(TaskFailure::Failed(pull_cancel_outcome_unknown()));
        }
        if snapshot.is_clean {
            return Err(TaskFailure::Cancelled);
        }

        let index_tree =
            capture_git_output(&self.git_program, repository_path, ["write-tree"], 1024)
                .await
                .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
        let merged_tree = pull_merge_index_tree(
            &self.git_program,
            repository_path,
            &expected.local_oid,
            &expected.tracking_oid,
        )
        .await
        .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
        if std::str::from_utf8(&index_tree).ok().map(str::trim) != Some(merged_tree.as_str()) {
            return Err(TaskFailure::Failed(pull_cancel_outcome_unknown()));
        }

        let mut command = Command::new(&self.git_program);
        command
            .args(["reset", "--merge"])
            .arg(&expected.local_oid)
            .current_dir(repository_path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(30), command.output())
            .await
            .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?
            .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
        if !output.status.success() {
            return Err(TaskFailure::Failed(pull_cancel_outcome_unknown()));
        }

        let restored = crate::remotes::pull::read_pull_preflight(
            expected.repo_id.clone(),
            repository_path,
            Some(&expected.local_branch),
            false,
        )
        .await
        .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?;
        if restored.local_oid == expected.local_oid
            && restored.tracking_oid == expected.tracking_oid
            && !restored.operation_in_progress
            && !restored.has_conflicts
            && capture_git_output(
                &self.git_program,
                repository_path,
                ["diff", "--cached", "--name-only", "-z"],
                2 * 1024 * 1024,
            )
            .await
            .is_ok_and(|staged_paths| staged_paths.is_empty())
        {
            Err(TaskFailure::Cancelled)
        } else {
            Err(TaskFailure::Failed(pull_cancel_outcome_unknown()))
        }
    }

    pub async fn execute_workflow(
        &self,
        repository_path: &Path,
        action: crate::domain::workflow::WorkflowAction,
        target_oid: &str,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let (arguments, label) = match action {
            crate::domain::workflow::WorkflowAction::Merge => (
                vec![
                    "merge".into(),
                    "--no-edit".into(),
                    "--".into(),
                    target_oid.into(),
                ],
                "Merge commit",
            ),
            crate::domain::workflow::WorkflowAction::CherryPick => (
                vec!["cherry-pick".into(), "--no-edit".into(), target_oid.into()],
                "Cherry-pick commit",
            ),
            crate::domain::workflow::WorkflowAction::Revert => (
                vec!["revert".into(), "--no-edit".into(), target_oid.into()],
                "Revert commit",
            ),
        };
        let result = run_command(
            &self.git_program,
            arguments,
            Some(format!(
                "{} {}",
                label.to_lowercase(),
                &target_oid[..7.min(target_oid.len())]
            )),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            label,
            task,
        )
        .await;
        workflow_command_result(&self.git_program, repository_path, result).await
    }

    pub async fn execute_rebase(
        &self,
        repository_path: &Path,
        execution: &crate::domain::workflow::RebaseExecutionPlan,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let todo_plan = TemporaryRebasePlan::create(execution)?;
        let backup_ref = format!("refs/gitcrest/rebase-backups/{}", task.task_id());
        run_command(
            &self.git_program,
            vec![
                "update-ref".into(),
                backup_ref.clone().into(),
                execution.expected_head_oid.clone().into(),
            ],
            Some(format!("rebase backup {backup_ref}")),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Create rebase backup reference",
            task.clone(),
        )
        .await?;
        task.log(format!("Created rollback reference {backup_ref}."))
            .await;
        let editor = "sh -c 'cat \"$GITCREST_REBASE_TODO_FILE\" > \"$1\"' --";
        let environment = vec![
            (
                OsString::from("GIT_SEQUENCE_EDITOR"),
                OsString::from(editor),
            ),
            (
                OsString::from("GITCREST_REBASE_TODO_FILE"),
                todo_plan.todo_file.as_os_str().to_owned(),
            ),
            (OsString::from("GIT_EDITOR"), OsString::from("true")),
        ];
        let result = run_command(
            &self.git_program,
            vec![
                "rebase".into(),
                "--interactive".into(),
                "--onto".into(),
                execution.onto_oid.clone().into(),
                execution.onto_oid.clone().into(),
            ],
            Some(format!(
                "rebase onto {}",
                &execution.onto_oid[..7.min(execution.onto_oid.len())]
            )),
            None,
            Vec::new(),
            environment,
            Some(repository_path),
            "Rebase branch",
            task,
        )
        .await;
        if result.is_ok()
            && matches!(
                workflow_state::read_operation(&self.git_program, repository_path).await,
                Ok(Some(crate::domain::workflow::WorkflowOperation::Rebase))
            )
        {
            return Err(TaskFailure::WaitingForInput(
                "Rebase paused at an edit step. Amend the current commit if needed, then continue or abort from Task Center.".into(),
            ));
        }
        workflow_command_result(&self.git_program, repository_path, result).await
    }

    pub async fn execute_rebase_rollback(
        &self,
        repository_path: &Path,
        expected_head_oid: &str,
        backup_oid: &str,
        backup_ref: &str,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let safety_ref = format!(
            "refs/gitcrest/rebase-backups/{}-before-rollback",
            task.task_id()
        );
        run_command(
            &self.git_program,
            vec![
                "update-ref".into(),
                safety_ref.clone().into(),
                expected_head_oid.into(),
            ],
            Some(format!("rebase rollback safety backup {safety_ref}")),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Save current branch before rebase rollback",
            task.clone(),
        )
        .await?;
        task.log(format!("Created safety reference {safety_ref}."))
            .await;
        task.log(format!("Restoring reviewed rebase backup {backup_ref}."))
            .await;
        run_command(
            &self.git_program,
            vec!["reset".into(), "--hard".into(), backup_oid.into()],
            Some(format!(
                "reset --hard {}",
                &backup_oid[..7.min(backup_oid.len())]
            )),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Restore rebase backup",
            task,
        )
        .await
    }

    pub async fn execute_reset(
        &self,
        repository_path: &Path,
        expected_head_oid: &str,
        target_oid: &str,
        mode_argument: &str,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let backup_ref = format!("refs/gitcrest/reset-backups/{}", task.task_id());
        run_command(
            &self.git_program,
            vec![
                "update-ref".into(),
                backup_ref.clone().into(),
                expected_head_oid.into(),
            ],
            Some(format!("reset backup {backup_ref}")),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Create reset backup reference",
            task.clone(),
        )
        .await?;
        task.log(format!("Created recovery reference {backup_ref}."))
            .await;
        run_command(
            &self.git_program,
            vec!["reset".into(), mode_argument.into(), target_oid.into()],
            Some(format!(
                "reset {mode_argument} {}",
                &target_oid[..7.min(target_oid.len())]
            )),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Reset current branch",
            task,
        )
        .await
    }

    pub async fn execute_reset_restore(
        &self,
        repository_path: &Path,
        expected_head_oid: &str,
        backup_oid: &str,
        backup_ref: &str,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let safety_ref = format!(
            "refs/gitcrest/reset-backups/{}-before-restore",
            task.task_id()
        );
        run_command(
            &self.git_program,
            vec![
                "update-ref".into(),
                safety_ref.clone().into(),
                expected_head_oid.into(),
            ],
            Some(format!("reset restore safety backup {safety_ref}")),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Save current branch before reset restore",
            task.clone(),
        )
        .await?;
        task.log(format!("Created safety reference {safety_ref}."))
            .await;
        task.log(format!("Restoring reviewed reset backup {backup_ref}."))
            .await;
        run_command(
            &self.git_program,
            vec!["reset".into(), "--hard".into(), backup_oid.into()],
            Some(format!(
                "reset --hard {}",
                &backup_oid[..7.min(backup_oid.len())]
            )),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Restore reset backup",
            task,
        )
        .await
    }

    pub async fn execute_workflow_recovery(
        &self,
        repository_path: &Path,
        operation: crate::domain::workflow::WorkflowOperation,
        action: crate::domain::workflow::WorkflowRecoveryAction,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let (arguments, label) = match (operation, action) {
            (crate::domain::workflow::WorkflowOperation::ShelfApply, _) => {
                return Err(TaskFailure::Failed(
                    "This recovery action is not a Git merge, cherry-pick, or revert.".into(),
                ));
            }
            (
                crate::domain::workflow::WorkflowOperation::Rebase,
                crate::domain::workflow::WorkflowRecoveryAction::Continue,
            ) => (
                vec!["rebase".into(), "--continue".into()],
                "Continue rebase",
            ),
            (
                crate::domain::workflow::WorkflowOperation::Rebase,
                crate::domain::workflow::WorkflowRecoveryAction::Skip,
            ) => (vec!["rebase".into(), "--skip".into()], "Skip rebase commit"),
            (
                crate::domain::workflow::WorkflowOperation::Rebase,
                crate::domain::workflow::WorkflowRecoveryAction::Abort,
            ) => (vec!["rebase".into(), "--abort".into()], "Abort rebase"),
            (_, crate::domain::workflow::WorkflowRecoveryAction::Continue) => (
                vec!["commit".into(), "--no-edit".into()],
                "Continue Git operation",
            ),
            (
                crate::domain::workflow::WorkflowOperation::CherryPick,
                crate::domain::workflow::WorkflowRecoveryAction::Skip,
            ) => (
                vec!["cherry-pick".into(), "--skip".into()],
                "Skip cherry-pick commit",
            ),
            (
                crate::domain::workflow::WorkflowOperation::Revert,
                crate::domain::workflow::WorkflowRecoveryAction::Skip,
            ) => (vec!["revert".into(), "--skip".into()], "Skip revert commit"),
            (
                crate::domain::workflow::WorkflowOperation::Merge,
                crate::domain::workflow::WorkflowRecoveryAction::Abort,
            ) => (vec!["merge".into(), "--abort".into()], "Abort merge"),
            (
                crate::domain::workflow::WorkflowOperation::CherryPick,
                crate::domain::workflow::WorkflowRecoveryAction::Abort,
            ) => (
                vec!["cherry-pick".into(), "--abort".into()],
                "Abort cherry-pick",
            ),
            (
                crate::domain::workflow::WorkflowOperation::Revert,
                crate::domain::workflow::WorkflowRecoveryAction::Abort,
            ) => (vec!["revert".into(), "--abort".into()], "Abort revert"),
            (
                crate::domain::workflow::WorkflowOperation::Merge,
                crate::domain::workflow::WorkflowRecoveryAction::Skip,
            ) => {
                return Err(TaskFailure::Failed(
                    "A merge operation cannot be skipped.".into(),
                ));
            }
        };
        let environment = if operation == crate::domain::workflow::WorkflowOperation::Rebase
            && action == crate::domain::workflow::WorkflowRecoveryAction::Continue
        {
            vec![(OsString::from("GIT_EDITOR"), OsString::from("true"))]
        } else {
            Vec::new()
        };
        let result = run_command(
            &self.git_program,
            arguments,
            Some(label.to_lowercase()),
            None,
            Vec::new(),
            environment,
            Some(repository_path),
            label,
            task,
        )
        .await;
        workflow_command_result(&self.git_program, repository_path, result).await
    }

    pub async fn execute_branch(
        &self,
        repository_path: &Path,
        operation: BranchCommand,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let (arguments, label) = match operation {
            BranchCommand::Create { name } => (
                vec!["branch".into(), "--".into(), name.into()],
                "Create branch",
            ),
            BranchCommand::Switch { name } => (
                vec![
                    "switch".into(),
                    "--no-guess".into(),
                    "--".into(),
                    name.into(),
                ],
                "Switch branch",
            ),
            BranchCommand::Rename { old_name, new_name } => (
                vec![
                    "branch".into(),
                    "--move".into(),
                    "--".into(),
                    old_name.into(),
                    new_name.into(),
                ],
                "Rename branch",
            ),
            BranchCommand::Delete {
                name,
                allow_unmerged,
            } => {
                let mut arguments = vec!["branch".into()];
                if allow_unmerged {
                    arguments.push("--delete".into());
                    arguments.push("--force".into());
                } else {
                    arguments.push("--delete".into());
                }
                arguments.extend(["--".into(), name.into()]);
                (arguments, "Delete branch")
            }
        };
        run_command(
            &self.git_program,
            arguments,
            None,
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            label,
            task,
        )
        .await
    }

    pub async fn execute_remote(
        &self,
        repository_path: &Path,
        operation: RemoteCommand,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let (arguments, label, log_label, redactions, next_default) = match operation {
            RemoteCommand::Add { name, url } => (
                vec![
                    "remote".into(),
                    "add".into(),
                    name.into(),
                    url.clone().into(),
                ],
                "Add remote",
                "remote add",
                vec![url],
                None,
            ),
            RemoteCommand::SetUrl { name, url } => (
                vec![
                    "remote".into(),
                    "set-url".into(),
                    name.into(),
                    url.clone().into(),
                ],
                "Update remote URL",
                "remote set-url",
                vec![url],
                None,
            ),
            RemoteCommand::Remove { name, next_default } => (
                vec!["remote".into(), "remove".into(), name.into()],
                "Remove remote",
                "remote remove",
                Vec::new(),
                next_default,
            ),
            RemoteCommand::SetDefault { name } => (
                vec![
                    "config".into(),
                    "--local".into(),
                    "gitcrest.defaultRemote".into(),
                    name.into(),
                ],
                "Set default remote",
                "config default remote",
                Vec::new(),
                None,
            ),
            RemoteCommand::SetUpstream {
                local_branch,
                remote_name,
                remote_branch,
            } => (
                vec![
                    "branch".into(),
                    "--set-upstream-to".into(),
                    format!("refs/remotes/{remote_name}/{remote_branch}").into(),
                    local_branch.into(),
                ],
                "Set branch upstream",
                "branch set upstream",
                Vec::new(),
                None,
            ),
        };
        run_command(
            &self.git_program,
            arguments,
            Some(log_label.into()),
            None,
            redactions,
            Vec::new(),
            Some(repository_path),
            label,
            task.clone(),
        )
        .await?;
        if let Some(default) = next_default {
            run_command(
                &self.git_program,
                vec![
                    "config".into(),
                    "--local".into(),
                    "gitcrest.defaultRemote".into(),
                    default.into(),
                ],
                None,
                None,
                Vec::new(),
                Vec::new(),
                Some(repository_path),
                "Update default remote",
                task,
            )
            .await?;
        }
        Ok(())
    }

    pub async fn execute_push(
        &self,
        repository_path: &Path,
        expected: &crate::remotes::push::PushPreflight,
        force_with_lease: bool,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let current = crate::remotes::push::read_push_preflight_for_target(
            expected.repo_id.clone(),
            repository_path,
            Some(&expected.local_branch),
            false,
            Some((&expected.remote_name, &expected.remote_branch)),
        )
        .await
        .map_err(|_| {
            TaskFailure::Failed(
                "Push preflight could not be revalidated. Refresh and retry.".into(),
            )
        })?;
        if current.local_oid != expected.local_oid
            || current.expected_remote_oid != expected.expected_remote_oid
            || current.remote_name != expected.remote_name
            || current.remote_branch != expected.remote_branch
        {
            return Err(TaskFailure::Failed(
                "Push preflight became stale before execution. Refresh and review the target again.".into(),
            ));
        }
        if current.ahead == 0 {
            return Err(TaskFailure::Failed(
                "There are no local commits to push.".into(),
            ));
        }
        if current.behind > 0 && !force_with_lease {
            return Err(TaskFailure::Failed(
                "The remote has commits missing locally. Fetch and review before pushing.".into(),
            ));
        }
        let mut arguments = vec!["push".into(), "--progress".into(), "--porcelain".into()];
        if force_with_lease {
            arguments.push(
                format!(
                    "--force-with-lease=refs/heads/{}:{}",
                    expected.remote_branch, expected.expected_remote_oid
                )
                .into(),
            );
        }
        arguments.extend([
            "--".into(),
            expected.remote_name.clone().into(),
            format!(
                "refs/heads/{}:refs/heads/{}",
                expected.local_branch, expected.remote_branch
            )
            .into(),
        ]);
        run_command(
            &self.git_program,
            arguments,
            Some(if force_with_lease {
                format!("push --force-with-lease {}", expected.remote_name)
            } else {
                format!("push {}", expected.remote_name)
            }),
            None,
            Vec::new(),
            askpass_environment()?,
            Some(repository_path),
            if force_with_lease {
                "Push with lease"
            } else {
                "Push"
            },
            task,
        )
        .await
    }

    pub async fn execute_remote_branch_delete(
        &self,
        repository_path: &Path,
        preview: &crate::remotes::RemoteBranchDeletePreview,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let remote_ref = format!("refs/heads/{}", preview.remote_branch);
        let lease = format!(
            "--force-with-lease={remote_ref}:{}",
            preview.expected_remote_oid
        );
        run_command(
            &self.git_program,
            vec![
                "push".into(),
                "--progress".into(),
                "--porcelain".into(),
                lease.into(),
                "--".into(),
                preview.remote_name.clone().into(),
                format!(":{remote_ref}").into(),
            ],
            Some(format!(
                "git push --delete {} {} with lease {}",
                preview.remote_name,
                preview.remote_branch,
                &preview.expected_remote_oid[..7.min(preview.expected_remote_oid.len())]
            )),
            None,
            Vec::new(),
            askpass_environment()?,
            Some(repository_path),
            "Delete remote branch",
            task.clone(),
        )
        .await?;
        if run_command(
            &self.git_program,
            vec![
                "update-ref".into(),
                "-d".into(),
                preview.target_ref.clone().into(),
                preview.expected_remote_oid.clone().into(),
            ],
            None,
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Remove deleted remote-tracking reference",
            task.clone(),
        )
        .await
        .is_err()
        {
            task.log("Remote branch was deleted, but the local tracking ref changed and could not be removed safely. Fetch with prune to refresh it.").await;
        }
        Ok(())
    }

    pub async fn execute_clone(
        &self,
        remote_url: &str,
        destination: &Path,
        parent: &Path,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let environment = askpass_environment()?;
        run_command(
            &self.git_program,
            [
                "clone".into(),
                "--progress".into(),
                "--".into(),
                remote_url.into(),
                destination.as_os_str().to_owned(),
            ]
            .into(),
            None,
            None,
            Vec::new(),
            environment,
            Some(parent),
            "Clone",
            task,
        )
        .await
    }

    pub async fn execute_staging(
        &self,
        repository_path: &Path,
        command: StagingCommand,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let StagingCommand {
            arguments,
            input,
            label,
            log_label,
        } = command;
        run_command(
            &self.git_program,
            arguments,
            Some(log_label.into()),
            input,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            label,
            task,
        )
        .await
    }

    // Commit execution keeps the isolation options beside the repository and task context.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_commit(
        &self,
        repository_path: &Path,
        message: String,
        amend: bool,
        sign_off: bool,
        sign: bool,
        selections: Option<Vec<u8>>,
        base_head: Option<String>,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let _temporary_index = if let Some(patch) = selections {
            let temporary = TemporaryIndex::create()?;
            let index_env = vec![(
                OsString::from("GIT_INDEX_FILE"),
                temporary.index.as_os_str().to_owned(),
            )];
            let read_tree = base_head.map_or_else(
                || vec!["read-tree".into(), "--empty".into()],
                |head| vec!["read-tree".into(), head.into()],
            );
            run_command(
                &self.git_program,
                read_tree,
                Some("read-tree <base> (temporary commit index)".into()),
                None,
                Vec::new(),
                index_env.clone(),
                Some(repository_path),
                "Prepare selected commit index",
                task.clone(),
            )
            .await?;
            run_command(
                &self.git_program,
                ["apply".into(), "--cached".into(), "--unidiff-zero".into()].into(),
                Some("apply selected staged patch to temporary commit index".into()),
                Some(patch),
                Vec::new(),
                index_env.clone(),
                Some(repository_path),
                "Prepare selected commit index",
                task.clone(),
            )
            .await?;
            Some((temporary, index_env))
        } else {
            None
        };
        let redactions = message
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect();
        let mut arguments = vec!["commit".into(), "--file=-".into()];
        if amend {
            arguments.push("--amend".into());
        }
        if sign_off {
            arguments.push("--signoff".into());
        }
        if sign {
            arguments.push("-S".into());
        } else {
            arguments.push("--no-gpg-sign".into());
        }
        run_command(
            &self.git_program,
            arguments,
            Some("commit --file=-".into()),
            Some(message.into_bytes()),
            redactions,
            _temporary_index
                .as_ref()
                .map_or_else(Vec::new, |(_, env)| env.clone()),
            Some(repository_path),
            "Commit",
            task,
        )
        .await
    }
}

async fn capture_git_output<const N: usize>(
    git_program: &str,
    repository_path: &Path,
    arguments: [&str; N],
    max_bytes: usize,
) -> Result<Vec<u8>, TaskFailure> {
    capture_git_output_args(
        git_program,
        repository_path,
        arguments.into_iter().map(OsString::from).collect(),
        max_bytes,
    )
    .await
}

fn validate_tree_ids(oids: &[&str]) -> Result<(), TaskFailure> {
    if oids.iter().any(|oid| {
        !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(TaskFailure::Failed(
            "Git returned an invalid index tree ID".into(),
        ));
    }
    Ok(())
}

async fn capture_git_output_args(
    git_program: &str,
    repository_path: &Path,
    arguments: Vec<OsString>,
    max_bytes: usize,
) -> Result<Vec<u8>, TaskFailure> {
    capture_git_output_args_with_env(git_program, repository_path, arguments, &[], max_bytes).await
}

async fn capture_git_output_args_with_env(
    git_program: &str,
    repository_path: &Path,
    arguments: Vec<OsString>,
    environment: &[(OsString, OsString)],
    max_bytes: usize,
) -> Result<Vec<u8>, TaskFailure> {
    let capture = async {
        let mut command = Command::new(git_program);
        command
            .args(arguments)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .envs(environment.iter().cloned())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .current_dir(repository_path);
        let mut child = command
            .spawn()
            .map_err(|_| TaskFailure::Failed("Git could not be started".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| TaskFailure::Failed("Git output could not be read".into()))?;
        let mut output = Vec::new();
        let read = stdout
            .take(max_bytes.saturating_add(1) as u64)
            .read_to_end(&mut output)
            .await;
        if read.is_err() || output.len() > max_bytes {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(TaskFailure::Failed(if output.len() > max_bytes {
                "The staging change is too large to keep an undo patch for".into()
            } else {
                "Git output could not be read".into()
            }));
        }
        let status = child
            .wait()
            .await
            .map_err(|_| TaskFailure::Failed("Git process ended unexpectedly".into()))?;
        finish_status(status)?;
        Ok(output)
    };
    tokio::time::timeout(Duration::from_secs(30), capture)
        .await
        .map_err(|_| {
            TaskFailure::Failed("Git index snapshot exceeded its 30-second deadline".into())
        })?
}

async fn workflow_command_result(
    git_program: &str,
    repository_path: &Path,
    result: Result<(), TaskFailure>,
) -> Result<(), TaskFailure> {
    if result.is_ok() {
        return result;
    }
    match workflow_state::read_operation(git_program, repository_path).await {
        Ok(Some(operation)) => Err(TaskFailure::WaitingForInput(format!(
            "{} stopped with an unresolved Git operation. Resolve the listed files, then continue or abort it.",
            match operation {
                crate::domain::workflow::WorkflowOperation::Merge => "Merge",
                crate::domain::workflow::WorkflowOperation::CherryPick => "Cherry-pick",
                crate::domain::workflow::WorkflowOperation::Revert => "Revert",
                crate::domain::workflow::WorkflowOperation::Rebase => "Rebase",
                crate::domain::workflow::WorkflowOperation::ShelfApply => "Shelf apply",
            }
        ))),
        Ok(None) | Err(_) => result,
    }
}

fn askpass_environment() -> Result<Vec<(OsString, OsString)>, TaskFailure> {
    let executable = std::env::current_exe().map_err(|_| {
        TaskFailure::Failed("The Git credential helper could not be located".into())
    })?;
    Ok(vec![
        (OsString::from("GIT_ASKPASS"), executable.into_os_string()),
        (
            OsString::from("GIT_ASKPASS_REQUIRE"),
            OsString::from("force"),
        ),
        (OsString::from("GITCREST_GIT_ASKPASS"), OsString::from("1")),
    ])
}

struct TemporaryIndex {
    directory: std::path::PathBuf,
    index: std::path::PathBuf,
}

impl TemporaryIndex {
    fn create() -> Result<Self, TaskFailure> {
        let parent = std::env::temp_dir();
        for _ in 0..10 {
            let directory = parent.join(format!(
                "gitcrest-commit-index-{}-{}",
                std::process::id(),
                NEXT_TEMP_INDEX.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&directory) {
                Ok(()) => {
                    let index = directory.join("index");
                    return Ok(Self { directory, index });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => break,
            }
        }
        Err(TaskFailure::Failed(
            "A temporary Git index could not be created".into(),
        ))
    }
}

async fn pull_merge_index_tree(
    git_program: &str,
    repository_path: &Path,
    local_oid: &str,
    tracking_oid: &str,
) -> Result<String, TaskFailure> {
    let base = capture_git_output_args(
        git_program,
        repository_path,
        vec!["merge-base".into(), local_oid.into(), tracking_oid.into()],
        1024,
    )
    .await?;
    let base = std::str::from_utf8(&base)
        .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))?
        .trim();
    if base.is_empty() {
        return Err(TaskFailure::Failed(pull_cancel_outcome_unknown()));
    }

    let temporary_index = TemporaryIndex::create()?;
    capture_git_output_args(
        git_program,
        repository_path,
        vec![
            "read-tree".into(),
            "-m".into(),
            format!("--index-output={}", temporary_index.index.display()).into(),
            base.into(),
            local_oid.into(),
            tracking_oid.into(),
        ],
        1024,
    )
    .await?;
    let index_environment = [(
        OsString::from("GIT_INDEX_FILE"),
        temporary_index.index.as_os_str().to_owned(),
    )];
    let tree = capture_git_output_args_with_env(
        git_program,
        repository_path,
        vec!["write-tree".into()],
        &index_environment,
        1024,
    )
    .await?;
    std::str::from_utf8(&tree)
        .map(str::trim)
        .map(str::to_owned)
        .map_err(|_| TaskFailure::Failed(pull_cancel_outcome_unknown()))
}

impl Drop for TemporaryIndex {
    fn drop(&mut self) {
        if let Ok(entries) = std::fs::read_dir(&self.directory) {
            for entry in entries.flatten() {
                if entry
                    .file_type()
                    .is_ok_and(|kind| kind.is_file() || kind.is_symlink())
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let _ = std::fs::remove_dir(&self.directory);
    }
}

struct TemporaryRebasePlan {
    directory: std::path::PathBuf,
    todo_file: std::path::PathBuf,
}

impl TemporaryRebasePlan {
    fn create(
        execution: &crate::domain::workflow::RebaseExecutionPlan,
    ) -> Result<Self, TaskFailure> {
        let parent = std::env::temp_dir();
        let directory = (0..10)
            .find_map(|_| {
                let directory = parent.join(format!(
                    "gitcrest-rebase-todo-{}-{}",
                    std::process::id(),
                    NEXT_TEMP_REBASE.fetch_add(1, Ordering::Relaxed)
                ));
                match std::fs::create_dir(&directory) {
                    Ok(()) => Some(directory),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                    Err(_) => None,
                }
            })
            .ok_or_else(|| {
                TaskFailure::Failed("A temporary rebase plan could not be created".into())
            })?;
        let plan = Self {
            todo_file: directory.join("todo"),
            directory,
        };
        let subjects = execution
            .commits
            .iter()
            .map(|commit| (commit.oid.as_str(), commit.subject.as_str()))
            .collect::<std::collections::HashMap<_, _>>();
        let mut lines = Vec::new();
        for (index, item) in execution.todo.iter().enumerate() {
            let subject = subjects.get(item.oid.as_str()).ok_or_else(|| {
                TaskFailure::Failed("The reviewed rebase todo no longer matches its preview".into())
            })?;
            if item.action == crate::domain::workflow::RebaseAction::Reword {
                let message_path = plan.directory.join(format!("message-{index}"));
                std::fs::write(
                    &message_path,
                    item.message.as_deref().unwrap_or_default().as_bytes(),
                )
                .map_err(|_| {
                    TaskFailure::Failed("A reword message could not be prepared".into())
                })?;
                lines.push(format!("pick {} {}", item.oid, subject));
                lines.push(format!(
                    "exec git commit --amend --file {}",
                    shell_quote_path(&message_path)?
                ));
            } else {
                lines.push(format!(
                    "{} {} {}",
                    item.action.git_keyword(),
                    item.oid,
                    subject
                ));
            }
        }
        std::fs::write(&plan.todo_file, lines.join("\n") + "\n").map_err(|_| {
            TaskFailure::Failed("The reviewed rebase todo could not be prepared".into())
        })?;
        Ok(plan)
    }
}

impl Drop for TemporaryRebasePlan {
    fn drop(&mut self) {
        if let Ok(entries) = std::fs::read_dir(&self.directory) {
            for entry in entries.flatten() {
                if entry
                    .file_type()
                    .is_ok_and(|kind| kind.is_file() || kind.is_symlink())
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn shell_quote_path(path: &Path) -> Result<String, TaskFailure> {
    let path = path
        .to_str()
        .ok_or_else(|| TaskFailure::Failed("A temporary rebase path could not be encoded".into()))?
        .replace('\\', "/");
    Ok(format!("'{}'", path.replace('\'', "'\\''")))
}

fn pull_cancel_outcome_unknown() -> String {
    "Pull cancellation outcome could not be verified. Inspect repository state before retrying."
        .into()
}

// Git command execution carries process, logging, cancellation, and repository context together.
#[allow(clippy::too_many_arguments)]
async fn run_command(
    git_program: &str,
    arguments: Vec<OsString>,
    log_label: Option<String>,
    input: Option<Vec<u8>>,
    redactions: Vec<String>,
    environment: Vec<(OsString, OsString)>,
    working_directory: Option<&Path>,
    label: &str,
    mut task: TaskContext,
) -> Result<(), TaskFailure> {
    task.progress(label, None).await;
    let rendered_args = log_label.unwrap_or_else(|| {
        arguments
            .iter()
            .map(|argument| argument.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ")
    });
    task.log(format!("git {rendered_args}")).await;

    let mut command = Command::new(git_program);
    command
        .args(&arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .envs(environment)
        .stdin(if input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(working_directory) = working_directory {
        command.current_dir(working_directory);
    }
    #[cfg(unix)]
    command.as_std_mut().process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| TaskFailure::Failed("Git could not be started".into()))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin_writer = if let Some(input) = input {
        child
            .stdin
            .take()
            .map(|mut stdin| tokio::spawn(async move { stdin.write_all(&input).await }))
    } else {
        None
    };
    let (activity_sender, mut activity) = watch::channel(Instant::now());
    let stdout_reader = stdout.map(|stream| {
        read_task_output(
            stream,
            task.clone(),
            activity_sender.clone(),
            redactions.clone(),
        )
    });
    let stderr_reader = stderr
        .map(|stream| read_task_output(stream, task.clone(), activity_sender.clone(), redactions));
    let execution_deadline = Instant::now() + GIT_EXECUTION_DEADLINE;
    let mut network_deadline = Instant::now() + GIT_NETWORK_NO_PROGRESS_DEADLINE;
    let status = loop {
        tokio::select! {
            biased;
            _ = task.cancelled() => {
                terminate_process_tree(&mut child).await;
                abort_reader(stdout_reader).await;
                abort_reader(stderr_reader).await;
                abort_writer(stdin_writer).await;
                return Err(TaskFailure::Cancelled);
            }
            _ = tokio::time::sleep_until(execution_deadline) => {
                terminate_process_tree(&mut child).await;
                abort_reader(stdout_reader).await;
                abort_reader(stderr_reader).await;
                abort_writer(stdin_writer).await;
                return Err(TaskFailure::Failed("Git operation exceeded its two-hour execution deadline".into()));
            }
            _ = tokio::time::sleep_until(network_deadline) => {
                terminate_process_tree(&mut child).await;
                abort_reader(stdout_reader).await;
                abort_reader(stderr_reader).await;
                abort_writer(stdin_writer).await;
                return Err(TaskFailure::Failed("Git operation made no progress before the five-minute network timeout".into()));
            }
            changed = activity.changed() => {
                if changed.is_ok() {
                    network_deadline = *activity.borrow() + GIT_NETWORK_NO_PROGRESS_DEADLINE;
                }
            }
            result = child.wait() => {
                match result {
                    Ok(status) => break status,
                    Err(_) => {
                        terminate_process_tree(&mut child).await;
                        abort_reader(stdout_reader).await;
                        abort_reader(stderr_reader).await;
                        abort_writer(stdin_writer).await;
                        return Err(TaskFailure::Failed("Git process ended unexpectedly".into()));
                    }
                }
            }
        }
    };
    if let Some(writer) = stdin_writer {
        if !matches!(writer.await, Ok(Ok(()))) {
            return Err(TaskFailure::Failed(
                "Git patch input could not be delivered".into(),
            ));
        }
    }
    await_reader(stdout_reader).await;
    await_reader(stderr_reader).await;
    finish_status(status)
}

fn finish_status(status: ExitStatus) -> Result<(), TaskFailure> {
    if status.success() {
        Ok(())
    } else {
        Err(TaskFailure::Failed(format!(
            "Git command failed with exit code {}",
            status
                .code()
                .map_or_else(|| "unknown".into(), |code| code.to_string())
        )))
    }
}

fn read_task_output<R>(
    stream: R,
    task: TaskContext,
    activity: watch::Sender<Instant>,
    redactions: Vec<String>,
) -> JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            activity.send_replace(Instant::now());
            if let Some(progress) = parse_progress(&line) {
                task.progress(progress_phase(&line), Some(progress)).await;
            }
            let line = redactions.iter().fold(line, |line, secret| {
                line.replace(secret, "[commit message]")
            });
            task.log(line).await;
        }
    })
}

async fn await_reader(reader: Option<JoinHandle<()>>) {
    if let Some(mut reader) = reader {
        if tokio::time::timeout(Duration::from_secs(2), &mut reader)
            .await
            .is_err()
        {
            reader.abort();
            let _ = reader.await;
        }
    }
}

async fn abort_writer(writer: Option<JoinHandle<std::io::Result<()>>>) {
    if let Some(writer) = writer {
        writer.abort();
        let _ = writer.await;
    }
}

async fn terminate_process_tree(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
            if tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .is_err()
            {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            let taskkill = std::env::var_os("SystemRoot")
                .map(|root| {
                    std::path::PathBuf::from(root)
                        .join("System32")
                        .join("taskkill.exe")
                })
                .unwrap_or_else(|| "taskkill.exe".into());
            let result = Command::new(taskkill)
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await;
            if result.is_err() {
                let _ = child.kill().await;
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.kill().await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}

async fn abort_reader(reader: Option<JoinHandle<()>>) {
    if let Some(reader) = reader {
        reader.abort();
        let _ = reader.await;
    }
}

fn parse_progress(line: &str) -> Option<u8> {
    let percent = line
        .split_whitespace()
        .find_map(|word| word.strip_suffix('%'))?;
    percent.parse::<u8>().ok().filter(|value| *value <= 100)
}

fn progress_phase(line: &str) -> &'static str {
    if line.contains("Writing objects") {
        "Writing objects"
    } else if line.contains("Compressing objects") {
        "Compressing objects"
    } else if line.contains("Enumerating objects") {
        "Enumerating objects"
    } else if line.contains("Resolving deltas") {
        "Resolving deltas"
    } else {
        "Receiving objects"
    }
}

#[cfg(test)]
mod tests {
    use std::{process::Command as StdCommand, time::Duration};

    use super::*;
    use crate::tasks::{TaskService, TaskStatus};

    fn git(path: &Path, args: &[&str]) {
        let output = StdCommand::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output(path: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn init_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        git(path, &["init", "--quiet"]);
        git(path, &["config", "user.name", "GitCrest Test"]);
        git(
            path,
            &["config", "user.email", "gitcrest-test@example.invalid"],
        );
        std::fs::write(path.join("seed.txt"), "seed\n").unwrap();
        git(path, &["add", "."]);
        git(path, &["commit", "--quiet", "-m", "seed"]);
    }

    #[test]
    fn parses_progress_and_keeps_command_set_typed() {
        assert_eq!(parse_progress("Receiving objects: 42% (42/100)"), Some(42));
        assert_eq!(
            progress_phase("Writing objects: 100% (2/2)"),
            "Writing objects"
        );
        assert_eq!(parse_progress("remote: Counting objects"), None);
        assert_eq!(GitOperation::Fetch.arguments(), ["fetch", "--progress"]);
        assert_eq!(
            GitOperation::FetchPrune.arguments(),
            ["fetch", "--progress", "--prune"]
        );
    }

    #[tokio::test]
    async fn fetch_task_uses_local_remote_and_records_sanitized_result() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let target = directory.path().join("target");
        let bare = directory.path().join("remote.git");
        init_repo(&source);
        init_repo(&target);
        let output = StdCommand::new("git")
            .arg("init")
            .arg("--bare")
            .arg("--quiet")
            .arg(&bare)
            .output()
            .unwrap();
        assert!(output.status.success());
        git(
            &source,
            &["remote", "add", "origin", bare.to_str().unwrap()],
        );
        git(&source, &["push", "--quiet", "-u", "origin", "HEAD"]);
        git(
            &target,
            &["remote", "add", "origin", bare.to_str().unwrap()],
        );

        let tasks = TaskService::default();
        let command = GitCommandService::default();
        let path = target;
        let task = tasks
            .submit(
                Some("repo".into()),
                None,
                "common-dir",
                "fetch",
                move |context| async move {
                    command
                        .execute(&path, GitOperation::Fetch, context)
                        .await
                        .map(|()| None)
                },
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let current = tasks.get(&task.task_id).await.unwrap();
                if matches!(
                    current.status,
                    TaskStatus::Succeeded | TaskStatus::Failed | TaskStatus::Cancelled
                ) {
                    break current;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let completed = tasks.get(&task.task_id).await.unwrap();
        assert_eq!(completed.status, TaskStatus::Succeeded);
        assert!(completed.logs.iter().any(|line| line.contains("From ")));
    }

    #[tokio::test]
    async fn push_succeeds_and_force_with_lease_rejects_a_remote_that_moved_after_preview() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let bare = directory.path().join("remote.git");
        let other = directory.path().join("other");
        init_repo(&source);
        git(
            directory.path(),
            &["init", "--bare", "--quiet", bare.to_str().unwrap()],
        );
        git(
            &source,
            &["remote", "add", "origin", bare.to_str().unwrap()],
        );
        let branch_output = StdCommand::new("git")
            .arg("-C")
            .arg(&source)
            .args(["branch", "--show-current"])
            .output()
            .unwrap();
        assert!(branch_output.status.success());
        let branch = String::from_utf8_lossy(&branch_output.stdout)
            .trim()
            .to_owned();
        git(&source, &["push", "--quiet", "-u", "origin", &branch]);
        std::fs::write(source.join("local.txt"), "local\n").unwrap();
        git(&source, &["add", "local.txt"]);
        git(&source, &["commit", "--quiet", "-m", "local push"]);

        let tasks = TaskService::default();
        let command = GitCommandService::default();
        let preview =
            crate::remotes::push::read_push_preflight("repo".into(), &source, Some(&branch), false)
                .await
                .unwrap();
        let path = source.clone();
        let task = tasks
            .submit(
                Some("repo".into()),
                None,
                "push-common-dir",
                "push",
                move |context| async move {
                    command
                        .execute_push(&path, &preview, false, context)
                        .await
                        .map(|()| None)
                },
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let current = tasks.get(&task.task_id).await.unwrap();
                if matches!(current.status, TaskStatus::Succeeded | TaskStatus::Failed) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            tasks.get(&task.task_id).await.unwrap().status,
            TaskStatus::Succeeded
        );
        assert_eq!(
            git_output(&bare, &["rev-parse", &format!("refs/heads/{branch}")]),
            git_output(&source, &["rev-parse", "HEAD"])
        );

        std::fs::write(source.join("next.txt"), "next\n").unwrap();
        git(&source, &["add", "next.txt"]);
        git(&source, &["commit", "--quiet", "-m", "next local push"]);
        let stale_preview =
            crate::remotes::push::read_push_preflight("repo".into(), &source, Some(&branch), false)
                .await
                .unwrap();
        git(
            directory.path(),
            &[
                "clone",
                "--quiet",
                bare.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        git(&other, &["config", "user.name", "Other Push Test"]);
        git(
            &other,
            &["config", "user.email", "other-push@example.invalid"],
        );
        std::fs::write(other.join("remote.txt"), "remote\n").unwrap();
        git(&other, &["add", "remote.txt"]);
        git(&other, &["commit", "--quiet", "-m", "remote moved"]);
        git(&other, &["push", "--quiet", "origin", &branch]);
        let remote_head = git_output(&bare, &["rev-parse", &format!("refs/heads/{branch}")]);

        let command = GitCommandService::default();
        let path = source.clone();
        let task = tasks
            .submit(
                Some("repo".into()),
                None,
                "push-common-dir",
                "pushForceWithLease",
                move |context| async move {
                    command
                        .execute_push(&path, &stale_preview, true, context)
                        .await
                        .map(|()| None)
                },
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let current = tasks.get(&task.task_id).await.unwrap();
                if matches!(current.status, TaskStatus::Succeeded | TaskStatus::Failed) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let failed = tasks.get(&task.task_id).await.unwrap();
        assert_eq!(failed.status, TaskStatus::Failed);
        assert_eq!(
            failed.error_category,
            Some(crate::tasks::TaskErrorCategory::PushRejected)
        );
        assert_eq!(
            git_output(&bare, &["rev-parse", &format!("refs/heads/{branch}")]),
            remote_head
        );

        git(&source, &["fetch", "--quiet", "origin"]);
        let force_preview =
            crate::remotes::push::read_push_preflight("repo".into(), &source, Some(&branch), false)
                .await
                .unwrap();
        assert_eq!((force_preview.ahead, force_preview.behind), (1, 1));
        let command = GitCommandService::default();
        let path = source.clone();
        let task = tasks
            .submit(
                Some("repo".into()),
                None,
                "push-common-dir",
                "pushForceWithLease",
                move |context| async move {
                    command
                        .execute_push(&path, &force_preview, true, context)
                        .await
                        .map(|()| None)
                },
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let current = tasks.get(&task.task_id).await.unwrap();
                if matches!(current.status, TaskStatus::Succeeded | TaskStatus::Failed) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            tasks.get(&task.task_id).await.unwrap().status,
            TaskStatus::Succeeded
        );
        assert_eq!(
            git_output(&bare, &["rev-parse", &format!("refs/heads/{branch}")]),
            git_output(&source, &["rev-parse", "HEAD"])
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_terminates_the_git_process_group_before_returning() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30 & wait"])
            .kill_on_drop(true)
            .as_std_mut()
            .process_group(0);
        let mut child = command.spawn().unwrap();
        terminate_process_tree(&mut child).await;
        assert!(child.try_wait().unwrap().is_some());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cancellation_terminates_the_windows_process_tree_before_returning() {
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        terminate_process_tree(&mut child).await;
        assert!(child.try_wait().unwrap().is_some());
    }
}
