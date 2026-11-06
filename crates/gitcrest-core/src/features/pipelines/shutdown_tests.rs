use super::{
    gitops::GitRunner,
    service::StartRun,
    service_tests::{auto_rule, harness},
};
use crate::{
    domain::pipeline::{HookCommand, RunStatus},
    ports::pipelines::PipelineStorePort,
};
use std::{sync::Arc, time::Duration};

struct Writer {
    directory: tempfile::TempDir,
    command: HookCommand,
}

impl Writer {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let command = {
            std::fs::write(directory.path().join("child.ps1"),
                "while ($true) { Add-Content -LiteralPath (Join-Path $PSScriptRoot 'progress') -Value 'tick'; Start-Sleep -Milliseconds 50 }\n").unwrap();
            std::fs::write(
                directory.path().join("parent.ps1"),
                r#"
$ErrorActionPreference = 'Stop'
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = Join-Path $PSHOME 'powershell.exe'
$info.Arguments = '-NoProfile -NonInteractive -File child.ps1'
$info.WorkingDirectory = $PSScriptRoot
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$child = [System.Diagnostics.Process]::Start($info)
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'child.pid') -Value $child.Id
$child.WaitForExit()
"#,
            )
            .unwrap();
            HookCommand {
                program: "powershell.exe".into(),
                args: vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-File".into(),
                    directory.path().join("parent.ps1").to_str().unwrap().into(),
                ],
                timeout_seconds: 60,
            }
        };
        #[cfg(unix)]
        let command = {
            std::fs::write(
                directory.path().join("child.sh"),
                "while :; do echo tick >>progress; sleep 0.05; done\n",
            )
            .unwrap();
            std::fs::write(directory.path().join("parent.sh"), "cd -- \"$(dirname -- \"$0\")\" || exit 1\nsh child.sh &\necho $! >child.pid\nwait\n").unwrap();
            HookCommand {
                program: "sh".into(),
                args: vec![directory.path().join("parent.sh").to_str().unwrap().into()],
                timeout_seconds: 60,
            }
        };
        Self { directory, command }
    }

    async fn ready(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if std::fs::metadata(self.directory.path().join("progress"))
                    .is_ok_and(|metadata| metadata.len() > 0)
                    && self.directory.path().join("child.pid").exists()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok()
    }

    async fn assert_stopped(&self) {
        let path = self.directory.path().join("progress");
        let before = std::fs::metadata(&path).unwrap().len();
        tokio::time::sleep(Duration::from_millis(400)).await;
        let after = std::fs::metadata(&path).unwrap().len();
        if before != after {
            // Failure cleanup targets only the PID created by this fixture,
            // whose continued writes were just observed.
            let pid = std::fs::read_to_string(self.directory.path().join("child.pid")).unwrap();
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("taskkill.exe")
                    .args(["/PID", pid.trim(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .output();
            }
            #[cfg(unix)]
            let _ = std::process::Command::new("kill")
                .args(["-TERM", pid.trim()])
                .output();
        }
        assert_eq!(
            before, after,
            "a child kept writing after shutdown completed"
        );
    }
}

#[tokio::test]
async fn shutdown_stops_the_pipeline_git_process_tree_before_returning() {
    let writer = Writer::new();
    let (signal, receiver) = tokio::sync::watch::channel(false);
    let runner = GitRunner::new()
        .with_program(writer.command.program.clone())
        .with_shutdown(receiver);
    let args = writer.command.args.clone();
    let directory = writer.directory.path().to_path_buf();
    let running = tokio::spawn(async move {
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        runner.git(&directory, &args, false).await
    });
    let ready = writer.ready().await;
    signal.send_replace(true);
    let result = tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .unwrap()
        .unwrap();
    assert!(ready, "the child must have started before cancellation");
    assert!(result.err().unwrap().message.contains("requires review"));
    writer.assert_stopped().await;
}

#[tokio::test]
async fn shutdown_drains_the_tracked_hook_and_rejects_new_pipeline_work() {
    let writer = Writer::new();
    let mut rule = auto_rule();
    rule.targets.clear();
    rule.commands = vec![writer.command.clone()];
    let harness = harness(rule);
    harness
        .service
        .start_run(
            "repo",
            StartRun::Manual {
                rule_id: "r_01".into(),
                source_branch: "feature/1".into(),
                source_oid: harness.fixture.source_oid.clone(),
                targets: None,
                execution_mode: None,
            },
        )
        .await
        .unwrap();
    let ready = writer.ready().await;
    harness.tasks.begin_shutdown().await;
    tokio::time::timeout(
        Duration::from_secs(10),
        harness.tasks.drain_workers(Duration::from_secs(1)),
    )
    .await
    .unwrap();
    assert!(ready, "the child must have started before cancellation");
    writer.assert_stopped().await;
    let run = harness
        .store
        .list_pipeline_runs("repo", 1)
        .unwrap()
        .remove(0);
    assert_eq!(run.status, RunStatus::Failed);
    assert!(run.steps[0]
        .message
        .as_deref()
        .unwrap()
        .contains("requires review"));
    assert!(harness
        .service
        .start_run(
            "repo",
            StartRun::Manual {
                rule_id: "r_01".into(),
                source_branch: "feature/1".into(),
                source_oid: harness.fixture.source_oid.clone(),
                targets: None,
                execution_mode: None,
            }
        )
        .await
        .is_err());
    assert_eq!(
        harness.store.list_pipeline_runs("repo", 10).unwrap().len(),
        1
    );
    assert!(!harness
        .tasks
        .spawn_background(async { panic!("shutdown must refuse new background work") }));
    assert_eq!(
        std::fs::read_to_string(harness.fixture.repository.join("base.txt")).unwrap(),
        "base\nlocal edit\n"
    );
}

#[tokio::test]
async fn closed_git_runner_does_not_start_a_process() {
    let writer = Writer::new();
    let (signal, receiver) = tokio::sync::watch::channel(false);
    signal.send_replace(true);
    let runner = GitRunner::new()
        .with_program(writer.command.program.clone())
        .with_shutdown(receiver);
    let args = writer
        .command
        .args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    assert!(runner
        .git(writer.directory.path(), &args, false)
        .await
        .is_err());
    assert!(!writer.directory.path().join("child.pid").exists());
}

#[tokio::test]
async fn cancelling_the_shutdown_waiter_preserves_a_background_write_until_it_finishes() {
    let tasks = crate::execution::TaskService::default();
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = done.clone();
    let (release, released) = tokio::sync::oneshot::channel();
    assert!(tasks.spawn_background(async move {
        let _ = released.await;
        observed.store(true, std::sync::atomic::Ordering::SeqCst);
    }));
    tasks.begin_shutdown().await;
    let draining = tasks.clone();
    let mut wait = tokio::spawn(async move {
        draining.drain_workers(Duration::from_millis(10)).await;
    });
    assert!(tokio::time::timeout(Duration::from_millis(100), &mut wait)
        .await
        .is_err());
    wait.abort();
    assert!(wait.await.unwrap_err().is_cancelled());
    assert!(!done.load(std::sync::atomic::Ordering::SeqCst));
    release.send(()).expect("the actual writer was retained");
    tasks.drain_workers(Duration::from_secs(1)).await;
    assert!(done.load(std::sync::atomic::Ordering::SeqCst));
}
