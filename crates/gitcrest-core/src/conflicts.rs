use std::{
    ffi::OsString,
    io,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{fs, process::Command};

use crate::workflows::WorkflowOperation;

const MAX_CONFLICT_FILE_BYTES: usize = 1024 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const GIT_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub repo_id: String,
    pub task_id: String,
    pub path: String,
    pub operation: WorkflowOperation,
    pub head_oid: Option<String>,
    pub base_content: Option<String>,
    pub ours_content: Option<String>,
    pub theirs_content: Option<String>,
    pub result_content: Option<String>,
    pub result_revision: String,
    pub is_text: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConflictError {
    InvalidPath,
    NotConflicted,
    FileNotFound,
    TooLarge,
    Binary,
    GitUnavailable,
    GitFailed,
    TimedOut,
    Io,
}

pub async fn read_file(
    repo_id: String,
    task_id: String,
    operation: WorkflowOperation,
    head_oid: Option<String>,
    repository_path: &Path,
    relative_path: &str,
) -> Result<ConflictFile, ConflictError> {
    validate_relative_path(relative_path)?;
    let index_stages = read_index_stages(repository_path, relative_path).await?;
    if index_stages.is_empty() {
        return Err(ConflictError::NotConflicted);
    }
    let base = read_stage(repository_path, index_stages.get(&1)).await?;
    let ours = read_stage(repository_path, index_stages.get(&2)).await?;
    let theirs = read_stage(repository_path, index_stages.get(&3)).await?;
    let result = read_worktree_file(repository_path, relative_path).await?;
    let is_text = [&base, &ours, &theirs, &result]
        .into_iter()
        .flatten()
        .all(|bytes| std::str::from_utf8(bytes).is_ok() && !bytes.contains(&0));
    let result_revision = revision(&result);
    let to_text = |value: Option<Vec<u8>>| value.and_then(|bytes| String::from_utf8(bytes).ok());
    Ok(ConflictFile {
        repo_id,
        task_id,
        path: relative_path.to_owned(),
        operation,
        head_oid,
        base_content: to_text(base),
        ours_content: to_text(ours),
        theirs_content: to_text(theirs),
        result_content: to_text(result),
        result_revision,
        is_text,
    })
}

pub fn validate_relative_path(value: &str) -> Result<(), ConflictError> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || Path::new(value).is_absolute()
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(ConflictError::InvalidPath);
    }
    Ok(())
}

fn revision(value: &Option<Vec<u8>>) -> String {
    let mut digest = Sha256::new();
    match value {
        Some(bytes) => {
            digest.update([1]);
            digest.update(bytes);
        }
        None => digest.update([0]),
    }
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn read_index_stages(
    repository_path: &Path,
    relative_path: &str,
) -> Result<std::collections::BTreeMap<u8, String>, ConflictError> {
    let output = git_output(
        repository_path,
        ["--literal-pathspecs", "ls-files", "-u", "-z", "--"],
        Some(OsString::from(relative_path)),
    )
    .await?;
    let mut stages = std::collections::BTreeMap::new();
    for record in output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
            return Err(ConflictError::GitFailed);
        };
        let header = std::str::from_utf8(&record[..tab]).map_err(|_| ConflictError::GitFailed)?;
        let mut parts = header.split_ascii_whitespace();
        let _mode = parts.next().ok_or(ConflictError::GitFailed)?;
        let oid = parts.next().ok_or(ConflictError::GitFailed)?;
        let stage = parts
            .next()
            .and_then(|value| value.parse::<u8>().ok())
            .ok_or(ConflictError::GitFailed)?;
        let path =
            std::str::from_utf8(&record[tab + 1..]).map_err(|_| ConflictError::InvalidPath)?;
        if path == relative_path && (1..=3).contains(&stage) {
            stages.insert(stage, oid.to_owned());
        }
    }
    Ok(stages)
}

async fn read_stage(
    repository_path: &Path,
    oid: Option<&String>,
) -> Result<Option<Vec<u8>>, ConflictError> {
    let Some(oid) = oid else { return Ok(None) };
    let size = git_output(repository_path, ["cat-file", "-s", oid.as_str()], None).await?;
    let size = std::str::from_utf8(&size)
        .map_err(|_| ConflictError::GitFailed)?
        .trim()
        .parse::<usize>()
        .map_err(|_| ConflictError::GitFailed)?;
    if size > MAX_CONFLICT_FILE_BYTES {
        return Err(ConflictError::TooLarge);
    }
    let bytes = git_output(repository_path, ["cat-file", "blob", oid.as_str()], None).await?;
    if bytes.len() > MAX_CONFLICT_FILE_BYTES {
        return Err(ConflictError::TooLarge);
    }
    Ok(Some(bytes))
}

async fn read_worktree_file(
    repository_path: &Path,
    relative_path: &str,
) -> Result<Option<Vec<u8>>, ConflictError> {
    let root = fs::canonicalize(repository_path)
        .await
        .map_err(|_| ConflictError::Io)?;
    let path = PathBuf::from(relative_path);
    let joined = root.join(path);
    let parent = joined.parent().ok_or(ConflictError::InvalidPath)?;
    let canonical_parent = fs::canonicalize(parent).await.map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            ConflictError::FileNotFound
        } else {
            ConflictError::Io
        }
    })?;
    if !canonical_parent.starts_with(&root) {
        return Err(ConflictError::InvalidPath);
    }
    let file_name = joined.file_name().ok_or(ConflictError::InvalidPath)?;
    let path = canonical_parent.join(file_name);
    let metadata = match fs::symlink_metadata(&path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ConflictError::Io),
    };
    if !metadata.file_type().is_file() {
        return Err(ConflictError::Binary);
    }
    if metadata.len() > MAX_CONFLICT_FILE_BYTES as u64 {
        return Err(ConflictError::TooLarge);
    }
    let bytes = fs::read(path).await.map_err(|_| ConflictError::Io)?;
    if bytes.len() > MAX_CONFLICT_FILE_BYTES {
        return Err(ConflictError::TooLarge);
    }
    Ok(Some(bytes))
}

async fn git_output<const N: usize>(
    repository_path: &Path,
    args: [&str; N],
    trailing_arg: Option<OsString>,
) -> Result<Vec<u8>, ConflictError> {
    let mut command = Command::new("git");
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

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use tempfile::TempDir;

    use super::*;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
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

    fn conflicting_repo() -> TempDir {
        let directory = tempfile::tempdir().unwrap();
        git(directory.path(), &["init", "--quiet"]);
        git(directory.path(), &["config", "user.name", "Fixture"]);
        git(
            directory.path(),
            &["config", "user.email", "fixture@example.test"],
        );
        fs::write(directory.path().join("file.txt"), "base\n").unwrap();
        git(directory.path(), &["add", "file.txt"]);
        git(directory.path(), &["commit", "--quiet", "-m", "base"]);
        let base = git(directory.path(), &["rev-parse", "HEAD"]);
        git(directory.path(), &["checkout", "--quiet", "-b", "theirs"]);
        fs::write(directory.path().join("file.txt"), "theirs\n").unwrap();
        git(directory.path(), &["commit", "--quiet", "-am", "theirs"]);
        git(
            directory.path(),
            &["checkout", "--quiet", "-b", "ours", &base],
        );
        fs::write(directory.path().join("file.txt"), "ours\n").unwrap();
        git(directory.path(), &["commit", "--quiet", "-am", "ours"]);
        let merge = Command::new("git")
            .arg("-C")
            .arg(directory.path())
            .args(["merge", "theirs"])
            .output()
            .unwrap();
        assert!(!merge.status.success());
        directory
    }

    #[tokio::test]
    async fn reads_three_stages_and_the_persisted_working_result() {
        let repository = conflicting_repo();
        let result = read_file(
            "repo_fixture".into(),
            "task_fixture".into(),
            WorkflowOperation::Merge,
            Some(git(repository.path(), &["rev-parse", "HEAD"])),
            repository.path(),
            "file.txt",
        )
        .await
        .unwrap();
        assert_eq!(result.base_content.as_deref(), Some("base\n"));
        assert_eq!(result.ours_content.as_deref(), Some("ours\n"));
        assert_eq!(result.theirs_content.as_deref(), Some("theirs\n"));
        assert!(result
            .result_content
            .as_deref()
            .unwrap()
            .contains("<<<<<<<"));
        assert!(result.is_text);
        assert_eq!(result.result_revision.len(), 64);
    }

    #[test]
    fn rejects_absolute_parent_and_empty_paths() {
        for path in ["", "../outside", "/absolute", "a/../outside"] {
            assert_eq!(
                validate_relative_path(path),
                Err(ConflictError::InvalidPath)
            );
        }
        assert_eq!(validate_relative_path("folder/file.txt"), Ok(()));
    }
}
