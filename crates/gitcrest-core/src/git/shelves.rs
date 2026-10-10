use std::{path::Path, process::Stdio, time::Duration};

use tokio::{io::AsyncWriteExt, process::Command};

use crate::{
    domain::{diff::DiffScope, error::GitAdapterError},
    ports::shelves::{ShelfPatchCheckFuture, ShelfPatchCheckPort},
};

use super::command::GitCommandService;

const SHELF_PATCH_CHECK_DEADLINE: Duration = Duration::from_secs(10);

impl ShelfPatchCheckPort for GitCommandService {
    fn check_shelf_patch<'a>(
        &'a self,
        repository_path: &'a Path,
        patch: &'a [u8],
        scope: DiffScope,
    ) -> ShelfPatchCheckFuture<'a, bool> {
        Box::pin(async move {
            let mut command = Command::new(&self.git_program);
            command
                .arg("-C")
                .arg(repository_path)
                .args(["apply", "--check"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            if scope == DiffScope::Index {
                command.arg("--index");
            }
            let mut child = command.spawn().map_err(|_| GitAdapterError::Unavailable)?;
            let mut stdin = child.stdin.take().ok_or(GitAdapterError::Failed)?;
            stdin
                .write_all(patch)
                .await
                .map_err(|_| GitAdapterError::Unavailable)?;
            drop(stdin);
            match tokio::time::timeout(SHELF_PATCH_CHECK_DEADLINE, child.wait()).await {
                Ok(Ok(status)) => Ok(status.success()),
                Ok(Err(_)) => Err(GitAdapterError::Unavailable),
                Err(_) => {
                    let _ = child.kill().await;
                    Err(GitAdapterError::TimedOut)
                }
            }
        })
    }
}
