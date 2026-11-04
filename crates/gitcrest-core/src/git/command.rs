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

use crate::credentials::{AccountSelections, ASKPASS_ACCOUNTS_ENV};
use crate::execution::{TaskContext, TaskFailure};
use crate::{
    domain::{
        branch::BranchCommand,
        error::WorkflowError,
        remote::{
            PushTags, RemoteBranchDeleteCommand, RemoteCommand, RemotePullCommand,
            RemotePullStrategy, RemotePushCommand,
        },
        staging::StagingOperation,
        workflow::{
            WorkflowBackupNamespace, WorkflowBackupReference, WorkflowRebaseCommitList,
            WorkflowRemoteBranchComparison, WorkflowResetComparison, WorkflowState,
        },
    },
    ports::git::GitReadPort,
    ports::status::StatusReadPort,
    ports::{
        branches::BranchGitPort,
        diff::DiffGitPort,
        remotes::{
            RemoteCommandFuture, RemoteCommandPort, RemoteGitPort, RemotePreflightFuture,
            RemotePreflightReadPort, RemotePullRecoveryFuture, RemotePullRecoveryPort,
        },
    },
};

use super::{history, refs, status};

const GIT_EXECUTION_DEADLINE: Duration = Duration::from_secs(2 * 60 * 60);
const GIT_NETWORK_NO_PROGRESS_DEADLINE: Duration = Duration::from_secs(5 * 60);
const MAX_CAPTURED_STAGING_PATCH_BYTES: usize = 20 * 1024 * 1024;
static NEXT_TEMP_INDEX: AtomicU64 = AtomicU64::new(1);
static NEXT_TEMP_REBASE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitOperation {
    Fetch,
    FetchPrune,
    FetchAll,
    FetchAllPrune,
}

impl GitOperation {
    fn arguments(self) -> &'static [&'static str] {
        match self {
            Self::Fetch => &["fetch", "--progress"],
            Self::FetchPrune => &["fetch", "--progress", "--prune"],
            Self::FetchAll => &["fetch", "--progress", "--all"],
            Self::FetchAllPrune => &["fetch", "--progress", "--all", "--prune"],
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Fetch => "Fetch",
            Self::FetchPrune => "Fetch and prune",
            Self::FetchAll => "Fetch all remotes",
            Self::FetchAllPrune => "Fetch all remotes and prune",
        }
    }
}

#[derive(Clone, Debug)]
pub struct GitCommandService {
    pub(super) git_program: String,
    account_selections: AccountSelections,
}

impl Default for GitCommandService {
    fn default() -> Self {
        Self {
            git_program: "git".into(),
            account_selections: AccountSelections::default(),
        }
    }
}

impl DiffGitPort for GitCommandService {
    async fn read_file_patch(
        &self,
        repository_path: &Path,
        relative_path: &str,
        scope: crate::domain::diff::DiffScope,
        untracked: bool,
        context: crate::domain::diff::DiffContext,
    ) -> Result<Vec<u8>, crate::domain::error::DiffError> {
        super::diff::read_file_patch(repository_path, relative_path, scope, untracked, context)
            .await
    }

    async fn read_commit_file_patch(
        &self,
        repository_path: &Path,
        oid: &str,
        parent_oid: Option<&str>,
        relative_path: &str,
        context: crate::domain::diff::DiffContext,
    ) -> Result<Vec<u8>, crate::domain::error::DiffError> {
        super::diff::read_commit_file_patch(
            repository_path,
            oid,
            parent_oid,
            relative_path,
            context,
        )
        .await
    }

    async fn read_worktree_range_patch(
        &self,
        repository_path: &Path,
        from_oid: &str,
        relative_path: &str,
        context: crate::domain::diff::DiffContext,
    ) -> Result<Vec<u8>, crate::domain::error::DiffError> {
        super::diff::read_worktree_range_patch(repository_path, from_oid, relative_path, context)
            .await
    }
}

impl StatusReadPort for GitCommandService {
    async fn read_status(
        &self,
        repo_id: String,
        repository_path: &Path,
        paths: &[String],
    ) -> Result<crate::domain::status::StatusSnapshot, std::io::Error> {
        super::status_snapshot::read_status(repo_id, repository_path, paths).await
    }
}

impl GitReadPort for GitCommandService {
    async fn resolve_commit_target(
        &self,
        repository_path: &Path,
        target: &str,
    ) -> Result<String, WorkflowError> {
        history::resolve_commit_target(&self.git_program, repository_path, target).await
    }

    async fn read_commit_subject(
        &self,
        repository_path: &Path,
        target_oid: &str,
    ) -> Result<String, WorkflowError> {
        history::read_commit_subject(&self.git_program, repository_path, target_oid).await
    }

    async fn read_head_oid(&self, repository_path: &Path) -> Result<Option<String>, WorkflowError> {
        history::read_head_oid(&self.git_program, repository_path).await
    }

    async fn read_current_branch(
        &self,
        repository_path: &Path,
    ) -> Result<Option<String>, WorkflowError> {
        history::read_current_branch(&self.git_program, repository_path).await
    }

    async fn read_worktree_state(
        &self,
        repository_path: &Path,
    ) -> Result<WorkflowState, WorkflowError> {
        status::read_worktree_state(&self.git_program, repository_path).await
    }

    async fn read_merge_relation(
        &self,
        repository_path: &Path,
        head_oid: &str,
        target_oid: &str,
    ) -> Result<crate::domain::workflow::MergeRelation, WorkflowError> {
        use crate::domain::workflow::{MergeKind, MergeRelation};
        let is_ancestor = |ancestor: &str, descendant: &str| {
            let mut command = Command::new(&self.git_program);
            command
                .args(["merge-base", "--is-ancestor", ancestor, descendant])
                .current_dir(repository_path)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            async move {
                match command.status().await {
                    Ok(status) if status.success() => Ok(true),
                    Ok(status) if status.code() == Some(1) => Ok(false),
                    _ => Err(WorkflowError::GitFailed),
                }
            }
        };
        let kind = if is_ancestor(target_oid, head_oid).await? {
            MergeKind::UpToDate
        } else if is_ancestor(head_oid, target_oid).await? {
            MergeKind::FastForward
        } else {
            MergeKind::MergeCommit
        };
        let range = format!("{head_oid}..{target_oid}");
        let count = capture_git_output(
            &self.git_program,
            repository_path,
            ["rev-list", "--count", range.as_str()],
            64,
        )
        .await
        .map_err(|_| WorkflowError::GitFailed)?;
        let incoming_commit_count = String::from_utf8_lossy(&count)
            .trim()
            .parse()
            .map_err(|_| WorkflowError::GitFailed)?;
        Ok(MergeRelation {
            kind,
            incoming_commit_count,
        })
    }

    async fn read_operation(
        &self,
        repository_path: &Path,
    ) -> Result<Option<crate::domain::workflow::WorkflowOperation>, WorkflowError> {
        status::read_operation(&self.git_program, repository_path).await
    }

    async fn list_backup_references(
        &self,
        repository_path: &Path,
        namespace: WorkflowBackupNamespace,
    ) -> Result<Vec<WorkflowBackupReference>, WorkflowError> {
        refs::list_backup_references(&self.git_program, repository_path, namespace).await
    }

    async fn compare_for_reset(
        &self,
        repository_path: &Path,
        head_oid: &str,
        target_oid: &str,
    ) -> Result<WorkflowResetComparison, WorkflowError> {
        history::compare_for_reset(&self.git_program, repository_path, head_oid, target_oid).await
    }

    async fn list_rebase_commits(
        &self,
        repository_path: &Path,
        onto_oid: &str,
        head_oid: &str,
    ) -> Result<WorkflowRebaseCommitList, WorkflowError> {
        history::list_rebase_commits(&self.git_program, repository_path, onto_oid, head_oid).await
    }

    async fn compare_remote_branch_delete(
        &self,
        repository_path: &Path,
        current_head_oid: Option<&str>,
        expected_remote_oid: &str,
    ) -> Result<WorkflowRemoteBranchComparison, WorkflowError> {
        refs::compare_remote_branch_delete(
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
            account_selections: AccountSelections::default(),
        }
    }

    /// Git network commands authenticate as the account selected for each host.
    pub fn with_account_selections(mut self, account_selections: AccountSelections) -> Self {
        self.account_selections = account_selections;
        self
    }

    /// The askpass environment for a Git command that talks to a remote, after renewing any
    /// selected account's OAuth token that is about to expire.
    pub(crate) async fn network_environment(
        &self,
    ) -> Result<Vec<(OsString, OsString)>, TaskFailure> {
        self.account_selections.refresh_expiring_tokens().await;
        askpass_environment(&self.account_selections)
    }

    pub async fn list_worktrees(
        &self,
        repository_path: &Path,
    ) -> Result<Vec<WorktreeEntry>, TaskFailure> {
        let output = capture_git_output(
            &self.git_program,
            repository_path,
            ["worktree", "list", "--porcelain"],
            256 * 1024,
        )
        .await?;
        Ok(parse_worktree_list(&String::from_utf8_lossy(&output)))
    }

    /// True when the working tree at `path` has tracked changes or untracked files.
    /// Output too large to capture also counts as dirty.
    pub async fn worktree_is_dirty(&self, path: &Path) -> bool {
        capture_git_output(
            &self.git_program,
            path,
            ["status", "--porcelain", "--untracked-files=normal"],
            64 * 1024,
        )
        .await
        .map(|output| !output.iter().all(u8::is_ascii_whitespace))
        .unwrap_or(true)
    }

    /// Paths Git ignores and does not track; ignored folders are reported as one entry ending in a slash.
    pub async fn list_ignored_paths(
        &self,
        repository_path: &Path,
    ) -> Result<Vec<String>, TaskFailure> {
        let output = capture_git_output(
            &self.git_program,
            repository_path,
            [
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ],
            1024 * 1024,
        )
        .await?;
        Ok(output
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect())
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
        let environment = self.network_environment().await?;
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

    /// Fetches one branch of one remote, refreshing its remote-tracking ref.
    pub async fn fetch_remote_branch(
        &self,
        repository_path: &Path,
        remote_name: &str,
        remote_branch: &str,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        run_command(
            &self.git_program,
            vec![
                "fetch".into(),
                "--progress".into(),
                "--".into(),
                remote_name.into(),
                remote_branch.into(),
            ],
            None,
            None,
            Vec::new(),
            self.network_environment().await?,
            Some(repository_path),
            "Fetch remote branch",
            task,
        )
        .await
    }

    /// Update a branch without changing the checkout; occupied linked worktrees are left alone.
    pub async fn fast_forward_upstream(
        &self,
        repository_path: &Path,
        name: &str,
        expected_oid: &str,
        remote: &str,
        remote_branch: &str,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let current = GitReadPort::read_current_branch(self, repository_path)
            .await
            .map_err(|_| TaskFailure::Failed("Could not read the current branch.".into()))?;
        let oid = self
            .resolve_commit_target(repository_path, &format!("refs/heads/{name}"))
            .await
            .map_err(|_| TaskFailure::Failed("The selected branch no longer exists.".into()))?;
        if oid != expected_oid {
            return Err(TaskFailure::Failed(
                "The branch changed after selection. Refresh and try again.".into(),
            ));
        }
        let arguments = if current.as_deref() == Some(name) {
            let state = self
                .read_worktree_state(repository_path)
                .await
                .map_err(|_| TaskFailure::Failed("Could not inspect the working tree.".into()))?;
            if !state.dirty_paths.is_empty()
                || !state.conflicted_paths.is_empty()
                || state.operation.is_some()
            {
                return Err(TaskFailure::Failed("Pull skipped: the current worktree has local changes or a Git operation in progress.".into()));
            }
            vec![
                "pull".into(),
                "--progress".into(),
                "--ff-only".into(),
                "--no-rebase".into(),
                "--no-autostash".into(),
                "--".into(),
                remote.into(),
                remote_branch.into(),
            ]
        } else {
            if self
                .list_worktrees(repository_path)
                .await?
                .iter()
                .any(|tree| tree.branch.as_deref() == Some(name))
            {
                return Err(TaskFailure::Failed("Pull skipped: this branch is checked out in another worktree. Open that worktree to update it.".into()));
            }
            // No '+' means Git rejects non-fast-forward updates; fetch also refuses checked-out branches.
            vec![
                "fetch".into(),
                "--progress".into(),
                "--no-tags".into(),
                "--".into(),
                remote.into(),
                format!("refs/heads/{remote_branch}:refs/heads/{name}").into(),
            ]
        };
        run_command(
            &self.git_program,
            arguments,
            None,
            None,
            Vec::new(),
            self.network_environment().await?,
            Some(repository_path),
            "Fast-forward branch",
            task,
        )
        .await
    }

    pub async fn execute_pull(
        &self,
        repository_path: &Path,
        expected: &RemotePullCommand,
        strategy: RemotePullStrategy,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let strategy_flag = match strategy {
            RemotePullStrategy::Merge => "--no-rebase",
            RemotePullStrategy::Rebase => "--rebase",
        };
        let result = run_command(
            &self.git_program,
            vec![
                "-c".into(),
                "merge.autoStash=false".into(),
                "-c".into(),
                "rebase.autoStash=false".into(),
                "pull".into(),
                "--progress".into(),
                "--no-edit".into(),
                strategy_flag.into(),
                "--".into(),
                expected.remote_name.clone().into(),
                expected.remote_branch.clone().into(),
            ],
            Some(match strategy {
                RemotePullStrategy::Merge => {
                    format!("pull --no-rebase {}", expected.remote_name)
                }
                RemotePullStrategy::Rebase => {
                    format!("pull --rebase {}", expected.remote_name)
                }
            }),
            None,
            Vec::new(),
            self.network_environment().await?,
            Some(repository_path),
            match strategy {
                RemotePullStrategy::Merge => "Pull with merge",
                RemotePullStrategy::Rebase => "Pull with rebase",
            },
            task,
        )
        .await;
        if matches!(result, Err(TaskFailure::Cancelled)) {
            return result;
        }
        workflow_command_result(&self.git_program, repository_path, result).await
    }
    pub async fn execute_workflow(
        &self,
        repository_path: &Path,
        action: crate::domain::workflow::WorkflowAction,
        target_oid: &str,
        no_fast_forward: bool,
        message: Option<&str>,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let (arguments, label) = match action {
            crate::domain::workflow::WorkflowAction::Merge => {
                let mut arguments: Vec<OsString> = vec!["merge".into()];
                match message {
                    Some(message) => arguments.extend(["-m".into(), message.into()]),
                    None => arguments.push("--no-edit".into()),
                }
                if no_fast_forward {
                    arguments.push("--no-ff".into());
                }
                arguments.extend(["--".into(), target_oid.into()]);
                (arguments, "Merge commit")
            }
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
                status::read_operation(&self.git_program, repository_path).await,
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
            (
                crate::domain::workflow::WorkflowOperation::ShelfApply
                | crate::domain::workflow::WorkflowOperation::ResolveConflicts,
                _,
            ) => {
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
            BranchCommand::Create {
                name,
                checkout,
                worktree_path,
                start_point,
            } => {
                let mut arguments: Vec<OsString> = match (&worktree_path, checkout) {
                    (Some(path), _) => vec![
                        "worktree".into(),
                        "add".into(),
                        "-b".into(),
                        name.clone().into(),
                        "--".into(),
                        path.clone().into(),
                    ],
                    (None, true) => vec!["switch".into(), "--create".into(), name.into()],
                    (None, false) => vec!["branch".into(), "--".into(), name.into()],
                };
                if let Some(start_point) = start_point {
                    arguments.push(start_point.into());
                }
                let label = match (&worktree_path, checkout) {
                    (Some(_), _) => "Create worktree",
                    (None, true) => "Create and switch branch",
                    (None, false) => "Create branch",
                };
                (arguments, label)
            }
            BranchCommand::Switch { name } => (
                vec![
                    "switch".into(),
                    "--no-guess".into(),
                    "--".into(),
                    name.into(),
                ],
                "Switch branch",
            ),
            BranchCommand::SwitchDetached { oid } => (
                vec!["switch".into(), "--detach".into(), "--".into(), oid.into()],
                "Check out commit",
            ),
            BranchCommand::SwitchTracking {
                local_branch,
                remote_ref,
            } => (
                vec![
                    "switch".into(),
                    "--track".into(),
                    "--create".into(),
                    local_branch.into(),
                    "--".into(),
                    remote_ref.into(),
                ],
                "Create tracking branch and switch",
            ),
            BranchCommand::FastForward {
                name,
                new_oid,
                expected_oid,
            } => (
                vec![
                    "update-ref".into(),
                    "-m".into(),
                    "gitcrest: fast-forward to remote branch".into(),
                    format!("refs/heads/{name}").into(),
                    new_oid.into(),
                    expected_oid.into(),
                ],
                "Fast-forward branch",
            ),
            BranchCommand::WorktreeAdd { branch, path } => (
                vec![
                    "worktree".into(),
                    "add".into(),
                    "--".into(),
                    path.into(),
                    branch.into(),
                ],
                "Create worktree",
            ),
            BranchCommand::WorktreeAddTracking {
                local_branch,
                remote_ref,
                path,
            } => (
                vec![
                    "worktree".into(),
                    "add".into(),
                    "--track".into(),
                    "-b".into(),
                    local_branch.into(),
                    "--".into(),
                    path.into(),
                    remote_ref.into(),
                ],
                "Create worktree",
            ),
            BranchCommand::WorktreePrune => (
                vec!["worktree".into(), "prune".into()],
                "Clean up missing worktrees",
            ),
            BranchCommand::WorktreeRemove { path, force } => {
                let mut arguments = vec!["worktree".into(), "remove".into()];
                if force {
                    arguments.push("--force".into());
                }
                arguments.extend(["--".into(), path.into()]);
                (arguments, "Remove worktree")
            }
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
        expected: &RemotePushCommand,
        force_with_lease: bool,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
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
        match expected.tags {
            PushTags::None => {}
            PushTags::FollowTags => arguments.push("--follow-tags".into()),
            PushTags::All => arguments.push("--tags".into()),
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
            self.network_environment().await?,
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

    /// Checks out the commits the superproject records for some submodules, cloning those that were
    /// never cloned when `init` is set. Progress and output reach the task log.
    pub async fn execute_submodule_update(
        &self,
        repository_path: &Path,
        paths: &[String],
        init: bool,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let mut arguments: Vec<OsString> =
            vec!["submodule".into(), "update".into(), "--progress".into()];
        if init {
            arguments.push("--init".into());
        }
        arguments.push("--recursive".into());
        arguments.push("--".into());
        arguments.extend(paths.iter().map(OsString::from));
        run_command(
            &self.git_program,
            arguments,
            Some(format!(
                "submodule update{} ({} paths)",
                if init { " --init" } else { "" },
                paths.len()
            )),
            None,
            Vec::new(),
            self.network_environment().await?,
            Some(repository_path),
            if init {
                "Initialize and update submodules"
            } else {
                "Update submodules"
            },
            task,
        )
        .await
    }

    /// Applies a stash entry to the working tree; `pop` also drops it, but only when it applied cleanly.
    pub async fn execute_stash_apply(
        &self,
        repository_path: &Path,
        index: usize,
        pop: bool,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let reference = format!("stash@{{{index}}}");
        run_command(
            &self.git_program,
            vec![
                "stash".into(),
                if pop { "pop" } else { "apply" }.into(),
                "--quiet".into(),
                reference.into(),
            ],
            Some(format!(
                "git stash {} stash@{{{index}}}",
                if pop { "pop" } else { "apply" }
            )),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            if pop { "Pop stash" } else { "Apply stash" },
            task,
        )
        .await
    }

    /// The object a tag points at on the remote, or `None` when the remote has no such tag.
    pub async fn read_remote_tag(
        &self,
        repository_path: &Path,
        remote_name: &str,
        tag_name: &str,
    ) -> Result<Option<String>, TaskFailure> {
        let reference = format!("refs/tags/{tag_name}");
        let output = capture_git_output_args_with_env(
            &self.git_program,
            repository_path,
            vec![
                "ls-remote".into(),
                "--tags".into(),
                "--".into(),
                remote_name.into(),
                reference.clone().into(),
            ],
            &self.network_environment().await?,
            64 * 1024,
        )
        .await?;
        Ok(String::from_utf8_lossy(&output).lines().find_map(|line| {
            let (oid, name) = line.split_once("\t")?;
            (name == reference).then(|| oid.to_owned())
        }))
    }

    /// Pushes one tag without force: Git itself refuses to move a tag the remote already has.
    pub async fn execute_tag_push(
        &self,
        repository_path: &Path,
        remote_name: &str,
        tag_name: &str,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let reference = format!("refs/tags/{tag_name}");
        run_command(
            &self.git_program,
            vec![
                "push".into(),
                "--progress".into(),
                "--porcelain".into(),
                "--".into(),
                remote_name.into(),
                format!("{reference}:{reference}").into(),
            ],
            Some(format!("push {remote_name} tag {tag_name}")),
            None,
            Vec::new(),
            self.network_environment().await?,
            Some(repository_path),
            "Push tag",
            task,
        )
        .await
    }

    /// Deletes a tag on the remote only while it still points at `expected_oid`.
    pub async fn execute_remote_tag_delete(
        &self,
        repository_path: &Path,
        remote_name: &str,
        tag_name: &str,
        expected_oid: &str,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let reference = format!("refs/tags/{tag_name}");
        run_command(
            &self.git_program,
            vec![
                "push".into(),
                "--progress".into(),
                "--porcelain".into(),
                format!("--force-with-lease={reference}:{expected_oid}").into(),
                "--".into(),
                remote_name.into(),
                format!(":{reference}").into(),
            ],
            Some(format!("git push --delete {remote_name} tag {tag_name}")),
            None,
            Vec::new(),
            self.network_environment().await?,
            Some(repository_path),
            "Delete remote tag",
            task,
        )
        .await
    }

    pub async fn execute_remote_branch_delete(
        &self,
        repository_path: &Path,
        command: &RemoteBranchDeleteCommand,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let remote_ref = format!("refs/heads/{}", command.remote_branch);
        let lease = format!(
            "--force-with-lease={remote_ref}:{}",
            command.expected_remote_oid
        );
        run_command(
            &self.git_program,
            vec![
                "push".into(),
                "--progress".into(),
                "--porcelain".into(),
                lease.into(),
                "--".into(),
                command.remote_name.clone().into(),
                format!(":{remote_ref}").into(),
            ],
            Some(format!(
                "git push --delete {} {} with lease {}",
                command.remote_name,
                command.remote_branch,
                &command.expected_remote_oid[..7.min(command.expected_remote_oid.len())]
            )),
            None,
            Vec::new(),
            self.network_environment().await?,
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
                command.target_ref.clone().into(),
                command.expected_remote_oid.clone().into(),
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
        let environment = self.network_environment().await?;
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
        operation: StagingOperation,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let (arguments, input, label, log_label) = super::index::staging_invocation(operation);
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

    /// Build the shelf's exact base from its patch, then merge trees. Unlike
    /// git apply --3way, a tree merge represents modify/delete conflicts too.
    pub async fn execute_shelf_three_way(
        &self,
        repository_path: &Path,
        patch: Vec<u8>,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let temporary = TemporaryIndex::create()?;
        run_command(
            &self.git_program,
            vec![
                "apply".into(),
                format!("--build-fake-ancestor={}", temporary.index.display()).into(),
            ],
            Some("git apply --build-fake-ancestor <shelf patch>".into()),
            Some(patch.clone()),
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Read shelf merge base",
            task.clone(),
        )
        .await?;
        let tree_path = repository_path.to_owned();
        let (base, current, saved) = tokio::task::spawn_blocking(move || {
            super::shelves::shelf_merge_trees(&tree_path, &temporary.index, &patch)
        })
        .await
        .map_err(|_| {
            TaskFailure::Failed(
                "The shelf merge could not be prepared. The shelf was retained.".into(),
            )
        })??;
        // read-tree checks the index/worktree against CURRENT before writing.
        // This also works when CURRENT contains previously restored staged edits.
        run_command(
            &self.git_program,
            vec![
                "read-tree".into(),
                "-m".into(),
                "-u".into(),
                base.into(),
                current.into(),
                saved.into(),
            ],
            Some("git read-tree -m -u <shelf base> <current index> <saved changes>".into()),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Merge saved local changes",
            task.clone(),
        )
        .await?;
        let conflict_path = repository_path.to_owned();
        let deleted_paths = tokio::task::spawn_blocking(move || {
            super::shelves::shelf_deleted_conflict_paths(&conflict_path)
        })
        .await
        .map_err(|_| {
            TaskFailure::Failed(
                "The shelf conflict files could not be inspected. The shelf was retained.".into(),
            )
        })??;
        if !deleted_paths.is_empty() {
            // Without --force, checkout-index refuses to overwrite a file that
            // appeared since read-tree. The saved stage remains in the index.
            run_command(
                &self.git_program,
                vec![
                    "checkout-index".into(),
                    "--stage=3".into(),
                    "-z".into(),
                    "--stdin".into(),
                ],
                Some("git checkout-index --stage=3 -z --stdin".into()),
                Some(deleted_paths),
                Vec::new(),
                Vec::new(),
                Some(repository_path),
                "Restore locally modified conflict files",
                task.clone(),
            )
            .await?;
        }
        run_command(
            &self.git_program,
            vec![
                "merge-index".into(),
                "-o".into(),
                "git-merge-one-file".into(),
                "-a".into(),
            ],
            Some("git merge-index -o git-merge-one-file -a".into()),
            None,
            Vec::new(),
            Vec::new(),
            Some(repository_path),
            "Resolve shelf file merges",
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

impl RemoteCommandPort for GitCommandService {
    fn execute_fetch<'a>(
        &'a self,
        repository_path: &'a Path,
        prune: bool,
        all: bool,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a> {
        Box::pin(async move {
            let operation = match (all, prune) {
                (true, true) => GitOperation::FetchAllPrune,
                (true, false) => GitOperation::FetchAll,
                (false, true) => GitOperation::FetchPrune,
                (false, false) => GitOperation::Fetch,
            };
            GitCommandService::execute(self, repository_path, operation, task).await
        })
    }

    fn execute_remote<'a>(
        &'a self,
        repository_path: &'a Path,
        operation: RemoteCommand,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a> {
        Box::pin(async move {
            GitCommandService::execute_remote(self, repository_path, operation, task).await
        })
    }

    fn delete_remote_branch<'a>(
        &'a self,
        repository_path: &'a Path,
        command: RemoteBranchDeleteCommand,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a> {
        Box::pin(async move {
            GitCommandService::execute_remote_branch_delete(self, repository_path, &command, task)
                .await
        })
    }

    fn pull<'a>(
        &'a self,
        repository_path: &'a Path,
        command: RemotePullCommand,
        strategy: RemotePullStrategy,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a> {
        Box::pin(async move {
            GitCommandService::execute_pull(self, repository_path, &command, strategy, task).await
        })
    }

    fn push<'a>(
        &'a self,
        repository_path: &'a Path,
        command: RemotePushCommand,
        force_with_lease: bool,
        task: TaskContext,
    ) -> RemoteCommandFuture<'a> {
        Box::pin(async move {
            GitCommandService::execute_push(self, repository_path, &command, force_with_lease, task)
                .await
        })
    }
}

impl RemotePullRecoveryPort for GitCommandService {
    fn is_am_rebase<'a>(&'a self, repository_path: &'a Path) -> RemotePullRecoveryFuture<'a, bool> {
        Box::pin(async move {
            let output = capture_git_output(
                &self.git_program,
                repository_path,
                ["rev-parse", "--git-path", "rebase-apply"],
                4096,
            )
            .await
            .map_err(|_| WorkflowError::GitFailed)?;
            let path = std::str::from_utf8(&output).map_err(|_| WorkflowError::GitFailed)?;
            let path = PathBuf::from(path.trim());
            let path = if path.is_absolute() {
                path
            } else {
                repository_path.join(path)
            };
            match tokio::fs::metadata(path).await {
                Ok(metadata) => Ok(metadata.is_dir()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(_) => Err(WorkflowError::GitFailed),
            }
        })
    }

    fn abort_rebase<'a>(
        &'a self,
        repository_path: &'a Path,
        am_rebase: bool,
    ) -> RemotePullRecoveryFuture<'a, ()> {
        Box::pin(async move {
            let arguments = if am_rebase {
                vec!["am".into(), "--abort".into()]
            } else {
                vec!["rebase".into(), "--abort".into()]
            };
            capture_git_output_args(&self.git_program, repository_path, arguments, 1024)
                .await
                .map(|_| ())
                .map_err(|_| WorkflowError::GitFailed)
        })
    }

    fn read_branch_oid<'a>(
        &'a self,
        repository_path: &'a Path,
        branch: &'a str,
    ) -> RemotePullRecoveryFuture<'a, String> {
        Box::pin(async move {
            let output = capture_git_output_args(
                &self.git_program,
                repository_path,
                vec![
                    "rev-parse".into(),
                    "--verify".into(),
                    format!("refs/heads/{branch}").into(),
                ],
                1024,
            )
            .await
            .map_err(|_| WorkflowError::GitFailed)?;
            std::str::from_utf8(&output)
                .map(str::trim)
                .map(str::to_owned)
                .map_err(|_| WorkflowError::GitFailed)
        })
    }

    fn read_current_branch<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemotePullRecoveryFuture<'a, String> {
        Box::pin(async move {
            let output = capture_git_output(
                &self.git_program,
                repository_path,
                ["branch", "--show-current"],
                1024,
            )
            .await
            .map_err(|_| WorkflowError::GitFailed)?;
            std::str::from_utf8(&output)
                .map(str::trim)
                .map(str::to_owned)
                .map_err(|_| WorkflowError::GitFailed)
        })
    }

    fn switch_branch<'a>(
        &'a self,
        repository_path: &'a Path,
        branch: &'a str,
    ) -> RemotePullRecoveryFuture<'a, ()> {
        Box::pin(async move {
            capture_git_output_args(
                &self.git_program,
                repository_path,
                vec!["switch".into(), "--".into(), branch.into()],
                1024,
            )
            .await
            .map(|_| ())
            .map_err(|_| WorkflowError::GitFailed)
        })
    }

    fn read_index_tree<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemotePullRecoveryFuture<'a, String> {
        Box::pin(async move {
            let output =
                capture_git_output(&self.git_program, repository_path, ["write-tree"], 1024)
                    .await
                    .map_err(|_| WorkflowError::GitFailed)?;
            std::str::from_utf8(&output)
                .map(str::trim)
                .map(str::to_owned)
                .map_err(|_| WorkflowError::GitFailed)
        })
    }

    fn read_merge_tree<'a>(
        &'a self,
        repository_path: &'a Path,
        local_oid: &'a str,
        tracking_oid: &'a str,
    ) -> RemotePullRecoveryFuture<'a, String> {
        Box::pin(async move {
            pull_merge_index_tree(&self.git_program, repository_path, local_oid, tracking_oid)
                .await
                .map_err(|_| WorkflowError::GitFailed)
        })
    }

    fn reset_merge<'a>(
        &'a self,
        repository_path: &'a Path,
        local_oid: &'a str,
    ) -> RemotePullRecoveryFuture<'a, ()> {
        Box::pin(async move {
            capture_git_output_args(
                &self.git_program,
                repository_path,
                vec!["reset".into(), "--merge".into(), local_oid.into()],
                1024,
            )
            .await
            .map(|_| ())
            .map_err(|_| WorkflowError::GitFailed)
        })
    }

    fn has_staged_changes<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemotePullRecoveryFuture<'a, bool> {
        Box::pin(async move {
            capture_git_output(
                &self.git_program,
                repository_path,
                ["diff", "--cached", "--name-only", "-z"],
                2 * 1024 * 1024,
            )
            .await
            .map(|paths| !paths.is_empty())
            .map_err(|_| WorkflowError::GitFailed)
        })
    }
}

impl RemotePreflightReadPort for GitCommandService {
    fn resolve_target<'a>(
        &'a self,
        repository_path: &'a Path,
        target: &'a str,
    ) -> RemotePreflightFuture<'a, String> {
        Box::pin(
            async move { GitReadPort::resolve_commit_target(self, repository_path, target).await },
        )
    }

    fn read_head<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemotePreflightFuture<'a, Option<String>> {
        Box::pin(async move { GitReadPort::read_head_oid(self, repository_path).await })
    }

    fn compare_delete_impact<'a>(
        &'a self,
        repository_path: &'a Path,
        current_head_oid: Option<&'a str>,
        target_oid: &'a str,
    ) -> RemotePreflightFuture<'a, WorkflowRemoteBranchComparison> {
        Box::pin(async move {
            GitReadPort::compare_remote_branch_delete(
                self,
                repository_path,
                current_head_oid,
                target_oid,
            )
            .await
        })
    }

    fn read_worktree<'a>(
        &'a self,
        repository_path: &'a Path,
    ) -> RemotePreflightFuture<'a, WorkflowState> {
        Box::pin(async move { GitReadPort::read_worktree_state(self, repository_path).await })
    }

    fn read_pull_state<'a>(
        &'a self,
        repository_path: &'a Path,
        local_branch: &'a str,
    ) -> RemotePreflightFuture<'a, crate::domain::remote::RemotePullState> {
        Box::pin(async move {
            let branch_git = super::refs::GitBranchAdapter;
            let remote_git = super::remote::GitRemoteAdapter;
            if !crate::domain::branch::is_branch_name_syntactically_valid(local_branch)
                || !branch_git
                    .validate_name(repository_path, local_branch)
                    .await
                    .map_err(map_remote_git_workflow_error)?
            {
                return Err(WorkflowError::InvalidTarget);
            }
            let upstream = remote_git
                .read_branch_upstream(repository_path, local_branch)
                .await
                .map_err(map_remote_git_workflow_error)?;
            if upstream.remote_name.is_empty()
                || upstream.remote_name == "."
                || !crate::domain::remote::is_remote_name_syntactically_valid(&upstream.remote_name)
                || !upstream.remote_ref.starts_with("refs/heads/")
            {
                return Err(WorkflowError::InvalidTarget);
            }
            if !remote_git
                .validate_name(repository_path, &upstream.remote_name)
                .await
                .map_err(map_remote_git_workflow_error)?
            {
                return Err(WorkflowError::InvalidTarget);
            }
            let remote_branch = upstream
                .remote_ref
                .strip_prefix("refs/heads/")
                .filter(|branch| !branch.is_empty())
                .ok_or(WorkflowError::InvalidTarget)?;
            if !crate::domain::branch::is_branch_name_syntactically_valid(remote_branch)
                || !branch_git
                    .validate_name(repository_path, remote_branch)
                    .await
                    .map_err(map_remote_git_workflow_error)?
            {
                return Err(WorkflowError::InvalidTarget);
            }
            let tracking_oid = remote_git
                .resolve_tracking_commit(repository_path, &upstream.remote_name, remote_branch)
                .await
                .map_err(map_remote_git_workflow_error)?
                .ok_or(WorkflowError::CommitNotFound)?;
            remote_git
                .compare_tracking_branch(
                    repository_path,
                    local_branch,
                    &upstream.remote_name,
                    remote_branch,
                )
                .await
                .map_err(map_remote_git_workflow_error)?;
            let worktree = GitReadPort::read_worktree_state(self, repository_path).await?;
            let has_conflicts =
                !worktree.conflicted_paths.is_empty() || worktree.omitted_conflicted_path_count > 0;
            let operation_in_progress = worktree.operation.is_some();
            Ok(crate::domain::remote::RemotePullState {
                local_oid: upstream.local_oid,
                remote_name: upstream.remote_name,
                remote_branch: remote_branch.to_owned(),
                tracking_oid,
                is_clean: worktree.dirty_paths.is_empty()
                    && !has_conflicts
                    && !operation_in_progress,
                has_conflicts,
                operation_in_progress,
            })
        })
    }
}

fn map_remote_git_workflow_error(error: crate::domain::error::GitAdapterError) -> WorkflowError {
    match error {
        crate::domain::error::GitAdapterError::Unavailable => WorkflowError::GitUnavailable,
        crate::domain::error::GitAdapterError::TimedOut => WorkflowError::TimedOut,
        crate::domain::error::GitAdapterError::OutputTooLarge => WorkflowError::TooLarge,
        crate::domain::error::GitAdapterError::Failed
        | crate::domain::error::GitAdapterError::ReferenceAlreadyExists => WorkflowError::GitFailed,
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
    match status::read_operation(git_program, repository_path).await {
        Ok(Some(operation)) => Err(TaskFailure::WaitingForInput(format!(
            "{} stopped with an unresolved Git operation. Resolve the listed files, then continue or abort it.",
            match operation {
                crate::domain::workflow::WorkflowOperation::Merge => "Merge",
                crate::domain::workflow::WorkflowOperation::CherryPick => "Cherry-pick",
                crate::domain::workflow::WorkflowOperation::Revert => "Revert",
                crate::domain::workflow::WorkflowOperation::Rebase => "Rebase",
                crate::domain::workflow::WorkflowOperation::ShelfApply => "Shelf apply",
                crate::domain::workflow::WorkflowOperation::ResolveConflicts => "Resolve conflicts",
            }
        ))),
        Ok(None) | Err(_) => result,
    }
}

fn askpass_environment(
    account_selections: &AccountSelections,
) -> Result<Vec<(OsString, OsString)>, TaskFailure> {
    let executable = std::env::current_exe().map_err(|_| {
        TaskFailure::Failed("The Git credential helper could not be located".into())
    })?;
    let mut environment = vec![
        (OsString::from("GIT_ASKPASS"), executable.into_os_string()),
        (
            OsString::from("GIT_ASKPASS_REQUIRE"),
            OsString::from("force"),
        ),
        (OsString::from("GITCREST_GIT_ASKPASS"), OsString::from("1")),
    ];
    environment.extend(account_environment(account_selections));
    Ok(environment)
}

/// Tells askpass which signed-in account answers for each host. Git consults credential helpers
/// before askpass, so a configured helper such as Git Credential Manager would otherwise answer for
/// these hosts with whatever it has stored; an empty URL-scoped `credential.helper` clears the
/// helper list for that host only.
fn account_environment(account_selections: &AccountSelections) -> Vec<(OsString, OsString)> {
    let Some(selections) = account_selections.env_value() else {
        return Vec::new();
    };
    let hosts = account_selections.hosts();
    let mut environment = vec![
        (
            OsString::from(ASKPASS_ACCOUNTS_ENV),
            OsString::from(selections),
        ),
        (
            OsString::from("GIT_CONFIG_COUNT"),
            OsString::from(hosts.len().to_string()),
        ),
    ];
    for (index, host) in hosts.iter().enumerate() {
        environment.push((
            OsString::from(format!("GIT_CONFIG_KEY_{index}")),
            OsString::from(format!("credential.https://{host}.helper")),
        ));
        environment.push((
            OsString::from(format!("GIT_CONFIG_VALUE_{index}")),
            OsString::new(),
        ));
    }
    environment
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

pub(crate) async fn terminate_process_tree(child: &mut tokio::process::Child) {
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
    use crate::features::tasks::{TaskService, TaskStatus};

    #[test]
    fn hands_selected_accounts_to_askpass_and_bypasses_helpers_only_for_their_hosts() {
        let selections = AccountSelections::default();
        assert!(account_environment(&selections).is_empty());

        let github = format!("acct_{}", "a".repeat(32));
        let gitlab = format!("acct_{}", "b".repeat(32));
        selections.replace(vec![
            ("github.com".into(), github.clone()),
            ("gitlab.example.com:8443".into(), gitlab.clone()),
        ]);
        let environment: Vec<(String, String)> = account_environment(&selections)
            .into_iter()
            .map(|(key, value)| (key.into_string().unwrap(), value.into_string().unwrap()))
            .collect();
        assert_eq!(
            environment,
            vec![
                (
                    ASKPASS_ACCOUNTS_ENV.to_string(),
                    format!("github.com={github};gitlab.example.com:8443={gitlab}")
                ),
                ("GIT_CONFIG_COUNT".into(), "2".into()),
                (
                    "GIT_CONFIG_KEY_0".into(),
                    "credential.https://github.com.helper".into()
                ),
                ("GIT_CONFIG_VALUE_0".into(), String::new()),
                (
                    "GIT_CONFIG_KEY_1".into(),
                    "credential.https://gitlab.example.com:8443.helper".into()
                ),
                ("GIT_CONFIG_VALUE_1".into(), String::new()),
            ]
        );
    }

    #[tokio::test]
    async fn renews_account_tokens_before_building_the_network_environment() {
        use std::{
            ffi::OsStr,
            sync::{atomic::AtomicUsize, Arc},
        };

        struct CountingRefresher(AtomicUsize);
        impl crate::credentials::AccountTokenRefresher for CountingRefresher {
            fn refresh_expiring_tokens(&self) -> crate::credentials::RefreshFuture<'_> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {})
            }
        }

        let selections = AccountSelections::default();
        let refresher = Arc::new(CountingRefresher(AtomicUsize::new(0)));
        selections.set_token_refresher(refresher.clone());
        let service = GitCommandService::default().with_account_selections(selections);
        let environment = service.network_environment().await.unwrap();
        assert_eq!(refresher.0.load(Ordering::SeqCst), 1);
        assert!(environment
            .iter()
            .any(|(key, _)| key == OsStr::new("GIT_ASKPASS")));
    }

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
        for all in [false, true] {
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

            git(
                &target,
                &["remote", "add", "secondary", bare.to_str().unwrap()],
            );
            let branch = git_output(&source, &["branch", "--show-current"]);
            let tasks = TaskService::default();
            let command = GitCommandService::default();
            let path = target.clone();
            let task = tasks
                .submit(
                    Some("repo".into()),
                    None,
                    "common-dir",
                    "fetch",
                    move |context| async move {
                        command
                            .execute_fetch(&path, false, all, context)
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
            let tracking = format!("refs/remotes/secondary/{branch}");
            let secondary = StdCommand::new("git")
                .arg("-C")
                .arg(&target)
                .args(["rev-parse", "--verify", &tracking])
                .output()
                .unwrap();
            assert_eq!(secondary.status.success(), all);
        }
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
        let preview = crate::features::remotes::push::read_push_preflight(
            "repo".into(),
            &source,
            Some(&branch),
            false,
        )
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
                        .execute_push(
                            &path,
                            &crate::domain::remote::RemotePushCommand::from(&preview),
                            false,
                            context,
                        )
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
        let stale_preview = crate::features::remotes::push::read_push_preflight(
            "repo".into(),
            &source,
            Some(&branch),
            false,
        )
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
                        .execute_push(
                            &path,
                            &crate::domain::remote::RemotePushCommand::from(&stale_preview),
                            true,
                            context,
                        )
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
            Some(crate::domain::task::TaskErrorCategory::PushRejected)
        );
        assert_eq!(
            git_output(&bare, &["rev-parse", &format!("refs/heads/{branch}")]),
            remote_head
        );

        git(&source, &["fetch", "--quiet", "origin"]);
        let force_preview = crate::features::remotes::push::read_push_preflight(
            "repo".into(),
            &source,
            Some(&branch),
            false,
        )
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
                        .execute_push(
                            &path,
                            &crate::domain::remote::RemotePushCommand::from(&force_preview),
                            true,
                            context,
                        )
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

/// One entry of `git worktree list --porcelain`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

fn parse_worktree_list(text: &str) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    for block in text.split("\n\n") {
        let mut entry: Option<WorktreeEntry> = None;
        for line in block.lines() {
            let line = line.trim_end_matches('\r');
            if let Some(path) = line.strip_prefix("worktree ") {
                entry = Some(WorktreeEntry {
                    path: path.to_string(),
                    head: None,
                    branch: None,
                    detached: false,
                    bare: false,
                    locked: false,
                    prunable: false,
                });
            } else if let Some(entry) = entry.as_mut() {
                if let Some(head) = line.strip_prefix("HEAD ") {
                    entry.head = Some(head.to_string());
                } else if let Some(branch) = line.strip_prefix("branch ") {
                    entry.branch = Some(
                        branch
                            .strip_prefix("refs/heads/")
                            .unwrap_or(branch)
                            .to_string(),
                    );
                } else if line == "detached" {
                    entry.detached = true;
                } else if line == "bare" {
                    entry.bare = true;
                } else if line == "locked" || line.starts_with("locked ") {
                    entry.locked = true;
                } else if line == "prunable" || line.starts_with("prunable ") {
                    entry.prunable = true;
                }
            }
        }
        if let Some(entry) = entry {
            entries.push(entry);
        }
    }
    entries
}

#[cfg(test)]
mod worktree_list_tests {
    use super::parse_worktree_list;

    #[test]
    fn parses_branch_detached_and_locked_worktrees() {
        let text = "worktree /repo\nHEAD aaaa\nbranch refs/heads/main\n\nworktree /repo-wt\nHEAD bbbb\ndetached\nlocked reason\n\n";
        let entries = parse_worktree_list(text);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert!(entries[1].detached && entries[1].locked);
        assert_eq!(entries[1].path, "/repo-wt");
    }
}
