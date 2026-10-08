use std::{path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

const TAG_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const TAG_OUTPUT_LIMIT: usize = 16 * 1024;
const MAX_TAG_MESSAGE_BYTES: usize = 8 * 1024;

use super::dto::CreatedTag;

#[derive(Debug, PartialEq, Eq)]
pub enum TagError {
    Invalid,
    AlreadyExists,
    CommitNotFound,
    GitUnavailable,
    TimedOut,
    GitFailed,
}

pub struct CreateTagRequest {
    pub name: String,
    pub oid: String,
    pub message: String,
}

pub async fn create(
    repo_id: String,
    repository_path: &Path,
    request: CreateTagRequest,
) -> Result<CreatedTag, TagError> {
    let ref_name = format!("refs/tags/{}", request.name);
    if request.name.is_empty()
        || request.name.len() > 255
        || request.name.chars().any(char::is_control)
        || request.oid.len() != 40 && request.oid.len() != 64
        || !request.oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        || request.message.len() > MAX_TAG_MESSAGE_BYTES
        || request.message.contains('\0')
    {
        return Err(TagError::Invalid);
    }

    let format = run_git(repository_path, &["check-ref-format", &ref_name], None).await?;
    if !format.success {
        return Err(TagError::Invalid);
    }
    let commit = run_git(repository_path, &["cat-file", "-t", &request.oid], None).await;
    match commit {
        Ok(output) if output.success && output.stdout.trim() == "commit" => {}
        Ok(_) | Err(TagError::GitFailed) => return Err(TagError::CommitNotFound),
        Err(error) => return Err(error),
    }

    let existing = run_git(
        repository_path,
        &["for-each-ref", "--format=%(refname)", "refs/tags"],
        None,
    )
    .await?;
    if existing.stdout.lines().any(|line| line == ref_name) {
        return Err(TagError::AlreadyExists);
    }

    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args([
            "tag",
            "--annotate",
            "--file=-",
            "--",
            &request.name,
            &request.oid,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| TagError::GitUnavailable)?;
    let stdin = child.stdin.take().ok_or(TagError::GitFailed)?;
    let stdout = child.stdout.take().ok_or(TagError::GitFailed)?;
    let stderr = child.stderr.take().ok_or(TagError::GitFailed)?;
    let stdout_reader = tokio::spawn(read_limited(stdout));
    let stderr_reader = tokio::spawn(read_limited(stderr));
    let message = request.message;
    let writer = tokio::spawn(async move {
        let mut stdin = stdin;
        stdin.write_all(message.as_bytes()).await?;
        stdin.shutdown().await
    });
    let wait_result = tokio::time::timeout(TAG_COMMAND_TIMEOUT, child.wait()).await;
    let status = match wait_result {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            let _ = child.kill().await;
            return Err(TagError::GitFailed);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(TagError::TimedOut);
        }
    };
    writer
        .await
        .map_err(|_| TagError::GitFailed)?
        .map_err(|_| TagError::GitFailed)?;
    let stdout = stdout_reader
        .await
        .map_err(|_| TagError::GitFailed)?
        .map_err(|_| TagError::GitFailed)?;
    let stderr = stderr_reader
        .await
        .map_err(|_| TagError::GitFailed)?
        .map_err(|_| TagError::GitFailed)?;
    if stdout.len() > TAG_OUTPUT_LIMIT || stderr.len() > TAG_OUTPUT_LIMIT {
        return Err(TagError::GitFailed);
    }
    if !status.success() {
        let error = String::from_utf8_lossy(&stderr).to_ascii_lowercase();
        return Err(if error.contains("already exists") {
            TagError::AlreadyExists
        } else {
            TagError::GitFailed
        });
    }

    Ok(CreatedTag {
        repo_id,
        name: request.name,
        full_name: ref_name,
        oid: request.oid,
    })
}

struct GitOutput {
    success: bool,
    stdout: String,
}

async fn run_git(
    repository_path: &Path,
    arguments: &[&str],
    input: Option<&[u8]>,
) -> Result<GitOutput, TagError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository_path)
        .args(arguments)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| TagError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(TagError::GitFailed)?;
    let reader = tokio::spawn(read_limited(stdout));
    if let Some(input) = input {
        let mut stdin = child.stdin.take().ok_or(TagError::GitFailed)?;
        stdin
            .write_all(input)
            .await
            .map_err(|_| TagError::GitFailed)?;
        stdin.shutdown().await.map_err(|_| TagError::GitFailed)?;
    }
    let status = match tokio::time::timeout(TAG_COMMAND_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            let _ = child.kill().await;
            return Err(TagError::GitFailed);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(TagError::TimedOut);
        }
    };
    let output = reader
        .await
        .map_err(|_| TagError::GitFailed)?
        .map_err(|_| TagError::GitFailed)?;
    if output.len() > TAG_OUTPUT_LIMIT {
        return Err(TagError::GitFailed);
    }
    Ok(GitOutput {
        success: status.success(),
        stdout: String::from_utf8_lossy(&output).into_owned(),
    })
}

async fn read_limited<R>(stream: R) -> std::io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    stream
        .take((TAG_OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut output)
        .await?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use std::{path::Path, process::Command as StdCommand};

    use super::*;

    fn git(path: &Path, args: &[&str]) -> String {
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

    #[tokio::test]
    async fn creates_annotated_tags_without_overwriting_existing_refs() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "--quiet"]);
        git(path, &["config", "user.name", "Tag Test"]);
        git(path, &["config", "user.email", "tag@example.invalid"]);
        std::fs::write(path.join("readme.txt"), "tag fixture\n").unwrap();
        git(path, &["add", "."]);
        git(path, &["commit", "--quiet", "-m", "tag fixture"]);
        let oid = git(path, &["rev-parse", "HEAD"]);

        let created = create(
            "repo_tag_test".into(),
            path,
            CreateTagRequest {
                name: "v1.0.0".into(),
                oid: oid.clone(),
                message: "Release 1.0.0".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(created.full_name, "refs/tags/v1.0.0");
        assert_eq!(git(path, &["cat-file", "-t", "refs/tags/v1.0.0"]), "tag");
        assert!(matches!(
            create(
                "repo_tag_test".into(),
                path,
                CreateTagRequest {
                    name: "v1.0.0".into(),
                    oid,
                    message: "duplicate".into()
                },
            )
            .await,
            Err(TagError::AlreadyExists)
        ));
        assert!(matches!(
            create(
                "repo_tag_test".into(),
                path,
                CreateTagRequest {
                    name: "../bad".into(),
                    oid: "a".repeat(40),
                    message: String::new()
                },
            )
            .await,
            Err(TagError::Invalid)
        ));
    }
}
