use std::{collections::BTreeMap, ffi::OsString, path::Path, process::Stdio, time::Duration};

use tokio::process::Command;

use crate::{
    domain::error::ConflictError,
    ports::conflicts::{ConflictGitFuture, ConflictGitPort},
};

use super::command::GitCommandService;

const MAX_CONFLICT_FILE_BYTES: usize = 1024 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const GIT_DEADLINE: Duration = Duration::from_secs(10);

impl ConflictGitPort for GitCommandService {
    fn read_conflict_stages<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
    ) -> ConflictGitFuture<'a, BTreeMap<u8, String>> {
        Box::pin(async move {
            let output = git_output(
                self,
                repository_path,
                ["--literal-pathspecs", "ls-files", "-u", "-z", "--"],
                Some(OsString::from(relative_path)),
            )
            .await?;
            let mut stages = BTreeMap::new();
            for record in output
                .split(|byte| *byte == 0)
                .filter(|record| !record.is_empty())
            {
                let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
                    return Err(ConflictError::GitFailed);
                };
                let header =
                    std::str::from_utf8(&record[..tab]).map_err(|_| ConflictError::GitFailed)?;
                let mut parts = header.split_ascii_whitespace();
                let _mode = parts.next().ok_or(ConflictError::GitFailed)?;
                let oid = parts.next().ok_or(ConflictError::GitFailed)?;
                let stage = parts
                    .next()
                    .and_then(|value| value.parse::<u8>().ok())
                    .ok_or(ConflictError::GitFailed)?;
                let path = std::str::from_utf8(&record[tab + 1..])
                    .map_err(|_| ConflictError::InvalidPath)?;
                if path == relative_path && (1..=3).contains(&stage) {
                    stages.insert(stage, oid.to_owned());
                }
            }
            Ok(stages)
        })
    }

    fn read_conflict_blob<'a>(
        &'a self,
        repository_path: &'a Path,
        oid: &'a str,
    ) -> ConflictGitFuture<'a, Vec<u8>> {
        Box::pin(async move {
            let size = git_output(self, repository_path, ["cat-file", "-s", oid], None).await?;
            let size = std::str::from_utf8(&size)
                .map_err(|_| ConflictError::GitFailed)?
                .trim()
                .parse::<usize>()
                .map_err(|_| ConflictError::GitFailed)?;
            if size > MAX_CONFLICT_FILE_BYTES {
                return Err(ConflictError::TooLarge);
            }
            let bytes = git_output(self, repository_path, ["cat-file", "blob", oid], None).await?;
            if bytes.len() > MAX_CONFLICT_FILE_BYTES {
                return Err(ConflictError::TooLarge);
            }
            Ok(bytes)
        })
    }

    fn resolve_conflict_side<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
        stage: u8,
        side_exists: bool,
    ) -> ConflictGitFuture<'a, ()> {
        Box::pin(async move {
            if !matches!(stage, 2 | 3) {
                return Err(ConflictError::GitFailed);
            }
            if side_exists {
                let side = if stage == 2 { "--ours" } else { "--theirs" };
                git_output(
                    self,
                    repository_path,
                    ["--literal-pathspecs", "checkout", side, "--"],
                    Some(OsString::from(relative_path)),
                )
                .await?;
                self.stage_conflict_file(repository_path, relative_path)
                    .await
            } else {
                git_output(
                    self,
                    repository_path,
                    ["--literal-pathspecs", "rm", "--quiet", "--force", "--"],
                    Some(OsString::from(relative_path)),
                )
                .await?;
                Ok(())
            }
        })
    }

    fn stage_conflict_file<'a>(
        &'a self,
        repository_path: &'a Path,
        relative_path: &'a str,
    ) -> ConflictGitFuture<'a, ()> {
        Box::pin(async move {
            git_output(
                self,
                repository_path,
                ["--literal-pathspecs", "add", "--"],
                Some(OsString::from(relative_path)),
            )
            .await?;
            Ok(())
        })
    }
}

async fn git_output<const N: usize>(
    service: &GitCommandService,
    repository_path: &Path,
    args: [&str; N],
    trailing_arg: Option<OsString>,
) -> Result<Vec<u8>, ConflictError> {
    let mut command = Command::new(&service.git_program);
    command.arg("-C").arg(repository_path).args(args);
    if let Some(argument) = trailing_arg {
        command.arg(argument);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_PAGER", "cat")
        .kill_on_drop(true);
    let output = tokio::time::timeout(GIT_DEADLINE, command.output())
        .await
        .map_err(|_| ConflictError::TimedOut)?
        .map_err(|_| ConflictError::GitUnavailable)?;
    if !output.status.success() {
        return Err(ConflictError::GitFailed);
    }
    if output.stdout.len() > MAX_CONFLICT_FILE_BYTES + MAX_STDERR_BYTES {
        return Err(ConflictError::TooLarge);
    }
    Ok(output.stdout)
}
