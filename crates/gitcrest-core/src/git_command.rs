use std::{ffi::OsString, path::Path, process::ExitStatus, time::Duration};

use tokio::{
    io::{AsyncBufReadExt, BufReader},
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitOperation {
    Fetch,
    FetchPrune,
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
        run_command(
            &self.git_program,
            operation.arguments().iter().map(OsString::from).collect(),
            None,
            Some(repository_path),
            operation.label(),
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
        run_command(
            &self.git_program,
            command.arguments,
            Some(command.log_label.into()),
            Some(repository_path),
            command.label,
            task,
        )
        .await
    }
}

async fn run_command(
    git_program: &str,
    arguments: Vec<OsString>,
    log_label: Option<String>,
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
        .stdin(std::process::Stdio::null())
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
    let (activity_sender, mut activity) = watch::channel(Instant::now());
    let stdout_reader =
        stdout.map(|stream| read_task_output(stream, task.clone(), activity_sender.clone()));
    let stderr_reader =
        stderr.map(|stream| read_task_output(stream, task.clone(), activity_sender.clone()));
    let execution_deadline = Instant::now() + GIT_EXECUTION_DEADLINE;
    let mut network_deadline = Instant::now() + GIT_NETWORK_NO_PROGRESS_DEADLINE;
    let status = loop {
        tokio::select! {
            biased;
            _ = task.cancelled() => {
                terminate_process_tree(&mut child).await;
                abort_reader(stdout_reader).await;
                abort_reader(stderr_reader).await;
                return Err(TaskFailure::Cancelled);
            }
            _ = tokio::time::sleep_until(execution_deadline) => {
                terminate_process_tree(&mut child).await;
                abort_reader(stdout_reader).await;
                abort_reader(stderr_reader).await;
                return Err(TaskFailure::Failed("Git operation exceeded its two-hour execution deadline".into()));
            }
            _ = tokio::time::sleep_until(network_deadline) => {
                terminate_process_tree(&mut child).await;
                abort_reader(stdout_reader).await;
                abort_reader(stderr_reader).await;
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
                        return Err(TaskFailure::Failed("Git process ended unexpectedly".into()));
                    }
                }
            }
        }
    };
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
) -> JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    activity.send_replace(Instant::now());
                    if let Some(progress) = parse_progress(&line) {
                        task.progress("Receiving objects", Some(progress)).await;
                    }
                    task.log(line).await;
                }
                Ok(None) | Err(_) => break,
            }
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

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, process::Command as StdCommand, time::Duration};

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
        let path = PathBuf::from(target);
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
