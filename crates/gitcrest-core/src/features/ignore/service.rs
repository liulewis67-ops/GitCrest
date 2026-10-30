use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use tokio::process::Command;

use super::dto::{IgnoreMode, IgnoreTarget};

const MAX_PATH_BYTES: usize = 1024;
const MAX_IGNORE_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IgnoreError {
    /// The path is empty, absolute, outside the repository, inside `.git`, or has an unusable shape.
    InvalidPath,
    /// An extension rule needs a file with an extension.
    NoExtension,
    GitUnavailable,
    Failed,
}

/// Escapes what gitignore treats specially so the line matches the literal name.
fn escape_pattern(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len() + 4);
    for (index, character) in text.chars().enumerate() {
        let special_start = index == 0 && matches!(character, '#' | '!');
        if special_start || matches!(character, '*' | '?' | '[' | ']' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    // A trailing space would be dropped by Git unless escaped.
    if escaped.ends_with(' ') {
        escaped.pop();
        escaped.push_str("\\ ");
    }
    escaped
}

/// A repository-relative path with `/` separators and no empty, `.` or `..` parts.
fn clean_path(path: &str) -> Result<(Vec<&str>, bool), IgnoreError> {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.contains('\0')
        || path.contains('\n')
        || path.contains('\r')
        || path.starts_with('/')
        || path.contains('\\')
    {
        return Err(IgnoreError::InvalidPath);
    }
    let is_directory = path.ends_with('/');
    let parts: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
        || parts[0].eq_ignore_ascii_case(".git")
    {
        return Err(IgnoreError::InvalidPath);
    }
    Ok((parts, is_directory))
}

/// The gitignore line for a path.
pub(super) fn build_line(path: &str, mode: IgnoreMode) -> Result<String, IgnoreError> {
    let (parts, is_directory) = clean_path(path)?;
    match mode {
        IgnoreMode::File => {
            let joined = parts
                .iter()
                .map(|part| escape_pattern(part))
                .collect::<Vec<_>>()
                .join("/");
            Ok(format!("/{joined}{}", if is_directory { "/" } else { "" }))
        }
        IgnoreMode::Extension => {
            if is_directory {
                return Err(IgnoreError::NoExtension);
            }
            let name = parts[parts.len() - 1];
            let extension = name
                .rsplit_once('.')
                .filter(|(stem, extension)| !stem.is_empty() && !extension.is_empty())
                .map(|(_, extension)| extension)
                .ok_or(IgnoreError::NoExtension)?;
            Ok(format!("*.{}", escape_pattern(extension)))
        }
        IgnoreMode::Folder => {
            let folder: &[&str] = if is_directory {
                &parts
            } else {
                &parts[..parts.len() - 1]
            };
            if folder.is_empty() {
                // A file in the repository root has no folder to ignore.
                return Err(IgnoreError::InvalidPath);
            }
            let joined = folder
                .iter()
                .map(|part| escape_pattern(part))
                .collect::<Vec<_>>()
                .join("/");
            Ok(format!("/{joined}/"))
        }
    }
}

async fn git_path(repository_path: &Path, relative: &str) -> Result<PathBuf, IgnoreError> {
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        Command::new("git")
            .arg("-C")
            .arg(repository_path)
            .args(["rev-parse", "--git-path", relative])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| IgnoreError::Failed)?
    .map_err(|_| IgnoreError::GitUnavailable)?;
    if !output.status.success() {
        return Err(IgnoreError::Failed);
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let path = PathBuf::from(text);
    Ok(if path.is_absolute() {
        path
    } else {
        repository_path.join(path)
    })
}

/// The file a rule goes into, and its display name.
pub(super) async fn target_file(
    repository_path: &Path,
    target: IgnoreTarget,
) -> Result<(PathBuf, &'static str), IgnoreError> {
    match target {
        IgnoreTarget::Gitignore => Ok((repository_path.join(".gitignore"), ".gitignore")),
        IgnoreTarget::Exclude => Ok((
            git_path(repository_path, "info/exclude").await?,
            ".git/info/exclude",
        )),
    }
}

async fn read_lines(file: &Path) -> Result<Option<String>, IgnoreError> {
    match tokio::fs::metadata(file).await {
        Ok(metadata) if metadata.len() > MAX_IGNORE_FILE_BYTES => Err(IgnoreError::Failed),
        Ok(_) => tokio::fs::read_to_string(file)
            .await
            .map(Some)
            .map_err(|_| IgnoreError::Failed),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(IgnoreError::Failed),
    }
}

pub(super) async fn is_present(file: &Path, line: &str) -> Result<bool, IgnoreError> {
    Ok(read_lines(file).await?.is_some_and(|content| {
        content
            .lines()
            .any(|existing| existing.trim_end_matches('\r') == line)
    }))
}

/// Appends the line on its own line; an existing identical line is left alone.
pub(super) async fn append_line(file: &Path, line: &str) -> Result<(), IgnoreError> {
    let existing = read_lines(file).await?;
    if existing.as_deref().is_some_and(|content| {
        content
            .lines()
            .any(|current| current.trim_end_matches('\r') == line)
    }) {
        return Ok(());
    }
    let mut content = existing.unwrap_or_default();
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(line);
    content.push('\n');
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| IgnoreError::Failed)?;
    }
    tokio::fs::write(file, content)
        .await
        .map_err(|_| IgnoreError::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_file_extension_and_folder_rules() {
        assert_eq!(
            build_line("build/out.log", IgnoreMode::File).unwrap(),
            "/build/out.log"
        );
        assert_eq!(
            build_line("build/out.log", IgnoreMode::Extension).unwrap(),
            "*.log"
        );
        assert_eq!(
            build_line("build/out.log", IgnoreMode::Folder).unwrap(),
            "/build/"
        );
        assert_eq!(build_line("dist/", IgnoreMode::File).unwrap(), "/dist/");
        assert_eq!(build_line("dist/", IgnoreMode::Folder).unwrap(), "/dist/");
        assert_eq!(
            build_line("a/b/c.txt", IgnoreMode::Folder).unwrap(),
            "/a/b/"
        );
    }

    #[test]
    fn escapes_characters_gitignore_reads_specially() {
        assert_eq!(
            build_line("#notes.txt", IgnoreMode::File).unwrap(),
            "/\\#notes.txt"
        );
        assert_eq!(build_line("!keep", IgnoreMode::File).unwrap(), "/\\!keep");
        assert_eq!(
            build_line("a[1].txt", IgnoreMode::File).unwrap(),
            "/a\\[1\\].txt"
        );
        assert_eq!(build_line("trail ", IgnoreMode::File).unwrap(), "/trail\\ ");
    }

    #[test]
    fn refuses_unsafe_paths_and_missing_extensions() {
        for path in [
            "",
            "/etc/passwd",
            "../x",
            "a/../b",
            ".git/config",
            "a\\b",
            "a\nb",
            "a//b",
            "./a",
        ] {
            assert_eq!(
                build_line(path, IgnoreMode::File),
                Err(IgnoreError::InvalidPath),
                "{path}"
            );
        }
        assert_eq!(
            build_line("Makefile", IgnoreMode::Extension),
            Err(IgnoreError::NoExtension)
        );
        assert_eq!(
            build_line(".env", IgnoreMode::Extension),
            Err(IgnoreError::NoExtension)
        );
        assert_eq!(
            build_line("dist/", IgnoreMode::Extension),
            Err(IgnoreError::NoExtension)
        );
        assert_eq!(
            build_line("root.txt", IgnoreMode::Folder),
            Err(IgnoreError::InvalidPath)
        );
    }
}
