use std::{
    ffi::OsString,
    path::Path,
    process::{ExitStatus, Stdio},
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

use crate::domain::{
    diff::{DiffContext, DiffScope},
    error::DiffError,
};

const MAX_DIFF_BYTES: usize = 10 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 16 * 1024;
const DIFF_DEADLINE: Duration = Duration::from_secs(10);

/// Context wide enough for every file whose patch fits [`MAX_DIFF_BYTES`]. `i32::MAX` itself overflows
/// in some Git versions (2.37 emits several overlapping, garbled hunks), so it stays far below that.
const FULL_FILE_CONTEXT_LINES: u32 = 100_000_000;

fn unified_argument(context: DiffContext) -> OsString {
    match context {
        DiffContext::Hunks => OsString::from("--unified=3"),
        // Git clamps context to the file, so the patch is one hunk spanning every line.
        DiffContext::FullFile => OsString::from(format!("--unified={FULL_FILE_CONTEXT_LINES}")),
    }
}

pub(crate) async fn read_file_patch(
    repository_path: &Path,
    relative_path: &str,
    scope: DiffScope,
    untracked: bool,
    context: DiffContext,
) -> Result<Vec<u8>, DiffError> {
    file_patch(
        repository_path,
        relative_path,
        scope,
        untracked,
        context,
        false,
    )
    .await
}

pub(crate) async fn read_checkout_patch(
    repository_path: &Path,
    relative_path: &str,
    scope: DiffScope,
    untracked: bool,
) -> Result<Vec<u8>, DiffError> {
    file_patch(
        repository_path,
        relative_path,
        scope,
        untracked,
        DiffContext::Hunks,
        true,
    )
    .await
}

async fn file_patch(
    repository_path: &Path,
    relative_path: &str,
    scope: DiffScope,
    untracked: bool,
    context: DiffContext,
    binary: bool,
) -> Result<Vec<u8>, DiffError> {
    let mut arguments = vec![
        OsString::from("--literal-pathspecs"),
        OsString::from("diff"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-color"),
        unified_argument(context),
    ];
    if binary {
        arguments.extend(["--binary", "--no-textconv", "--no-renames"].map(OsString::from));
    }
    if scope == DiffScope::Index {
        arguments.push("--cached".into());
    } else if untracked {
        arguments.push("--no-index".into());
    }
    arguments.push("--".into());
    if untracked {
        arguments.push("/dev/null".into());
    }
    arguments.push(relative_path.into());

    run_diff(repository_path, arguments, untracked).await
}

pub(crate) async fn read_commit_file_patch(
    repository_path: &Path,
    oid: &str,
    parent_oid: Option<&str>,
    relative_path: &str,
    context: DiffContext,
) -> Result<Vec<u8>, DiffError> {
    let mut arguments = vec![
        OsString::from("--literal-pathspecs"),
        OsString::from(if parent_oid.is_some() {
            "diff"
        } else {
            "diff-tree"
        }),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-color"),
        unified_argument(context),
    ];
    if let Some(parent_oid) = parent_oid {
        arguments.push(parent_oid.into());
        arguments.push(oid.into());
    } else {
        arguments.extend(
            ["--root", "--no-commit-id", "-p", "-r", oid]
                .into_iter()
                .map(OsString::from),
        );
    }
    arguments.push("--".into());
    arguments.push(relative_path.into());
    run_diff(repository_path, arguments, false).await
}

/// One file of the working tree against a commit.
pub(crate) async fn read_worktree_range_patch(
    repository_path: &Path,
    from_oid: &str,
    relative_path: &str,
    context: DiffContext,
) -> Result<Vec<u8>, DiffError> {
    let arguments = vec![
        OsString::from("--literal-pathspecs"),
        OsString::from("diff"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-color"),
        unified_argument(context),
        from_oid.into(),
        OsString::from("--"),
        relative_path.into(),
    ];
    run_diff(repository_path, arguments, false).await
}

async fn run_diff(
    repository_path: &Path,
    arguments: Vec<OsString>,
    allow_exit_code_one: bool,
) -> Result<Vec<u8>, DiffError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_PAGER", "cat")
        .env("GIT_NO_LAZY_FETCH", "1")
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => DiffError::GitUnavailable,
        std::io::ErrorKind::PermissionDenied => DiffError::PermissionDenied,
        _ => DiffError::GitUnavailable,
    })?;
    let stdout = child.stdout.take().ok_or(DiffError::GitFailed)?;
    let stderr = child.stderr.take().ok_or(DiffError::GitFailed)?;
    let stdout_reader = tokio::spawn(read_capped(stdout, MAX_DIFF_BYTES));
    let stderr_reader = tokio::spawn(read_capped(stderr, MAX_ERROR_BYTES));
    let result = tokio::time::timeout(DIFF_DEADLINE, async {
        let status = child.wait().await.map_err(|_| DiffError::GitFailed)?;
        let stdout = stdout_reader
            .await
            .map_err(|_| DiffError::GitFailed)?
            .map_err(|_| DiffError::GitFailed)?;
        let stderr = stderr_reader
            .await
            .map_err(|_| DiffError::GitFailed)?
            .map_err(|_| DiffError::GitFailed)?;
        Ok::<_, DiffError>((status, stdout, stderr))
    })
    .await;
    let (status, stdout, stderr) = match result {
        Ok(result) => result?,
        Err(_) => {
            let _ = child.kill().await;
            return Err(DiffError::TimedOut);
        }
    };
    if stdout.overflowed {
        return Err(DiffError::TooLarge);
    }
    if !is_success(status, allow_exit_code_one) {
        return Err(classify_git_error(
            &String::from_utf8_lossy(&stderr.bytes).to_ascii_lowercase(),
        ));
    }
    Ok(stdout.bytes)
}

fn is_success(status: ExitStatus, allow_exit_code_one: bool) -> bool {
    status.success() || (allow_exit_code_one && status.code() == Some(1))
}

fn classify_git_error(error: &str) -> DiffError {
    if error.contains("permission denied") || error.contains("access is denied") {
        DiffError::PermissionDenied
    } else if error.contains("could not access") || error.contains("no such file") {
        DiffError::PathNotFound
    } else {
        DiffError::GitFailed
    }
}

async fn read_capped<R: AsyncRead + Unpin>(
    mut stream: R,
    limit: usize,
) -> std::io::Result<CappedOutput> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut chunk = [0_u8; 8192];
    let mut overflowed = false;
    loop {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let available = limit.saturating_sub(bytes.len());
        let kept = available.min(count);
        bytes.extend_from_slice(&chunk[..kept]);
        overflowed |= kept != count;
    }
    Ok(CappedOutput { bytes, overflowed })
}

struct CappedOutput {
    bytes: Vec<u8>,
    overflowed: bool,
}
