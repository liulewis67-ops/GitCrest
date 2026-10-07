use std::sync::atomic::{AtomicU64, Ordering};
use std::{ffi::OsString, path::Path, process::ExitStatus, time::Duration};

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::watch,
    task::JoinHandle,
    time::Instant,
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::staging::StagingCommand;
use crate::tasks::{TaskContext, TaskFailure};

const GIT_EXECUTION_DEADLINE: Duration = Duration::from_secs(2 * 60 * 60);
const GIT_NETWORK_NO_PROGRESS_DEADLINE: Duration = Duration::from_secs(5 * 60);
static NEXT_TEMP_INDEX: AtomicU64 = AtomicU64::new(1);

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

impl GitCommandService {
    #[allow(dead_code)]
    pub fn with_program(git_program: impl Into<String>) -> Self {
        Self {
            git_program: git_program.into(),
        }
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
        expected: &crate::pull::PullPreflight,
        strategy: crate::pull::PullStrategy,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let current = crate::pull::read_pull_preflight(
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
            crate::pull::PullStrategy::Merge => "--no-rebase",
            crate::pull::PullStrategy::Rebase => "--rebase",
        };
        run_command(
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
                crate::pull::PullStrategy::Merge => {
                    format!("pull --no-rebase {}", expected.remote_name)
                }
                crate::pull::PullStrategy::Rebase => {
                    format!("pull --rebase {}", expected.remote_name)
                }
            }),
            None,
            Vec::new(),
            askpass_environment()?,
            Some(repository_path),
            match strategy {
                crate::pull::PullStrategy::Merge => "Pull with merge",
                crate::pull::PullStrategy::Rebase => "Pull with rebase",
            },
            task,
        )
        .await
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
        expected: &crate::push::PushPreflight,
        force_with_lease: bool,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let current = crate::push::read_push_preflight(
            expected.repo_id.clone(),
            repository_path,
            Some(&expected.local_branch),
            false,
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
            "A temporary index could not be created for the selected commit".into(),
        ))
    }
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
            crate::push::read_push_preflight("repo".into(), &source, Some(&branch), false)
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
            crate::push::read_push_preflight("repo".into(), &source, Some(&branch), false)
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
            crate::push::read_push_preflight("repo".into(), &source, Some(&branch), false)
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
