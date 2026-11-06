//! Opt-in copying of Git-ignored local files (for example .env) into a new worktree.
//!
//! Nothing is copied unless the caller names the files, and only small regular files that Git reports as
//! ignored and untracked, inside the repository, can be named.

use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use crate::git::command::GitCommandService;

const MAX_COPY_FILE_BYTES: u64 = 256 * 1024;
const MAX_LISTED_FILES: usize = 100;

pub(super) struct CopyableFiles {
    pub(super) files: Vec<(String, u64)>,
    /// Ignored folders, large files and files beyond the listing limit that are not offered.
    pub(super) omitted: usize,
}

fn is_plain_relative(path: &str) -> bool {
    let candidate = Path::new(path);
    !path.is_empty()
        && !path.contains(['\\', ':'])
        && !candidate.is_absolute()
        && candidate.components().all(|component| match component {
            Component::Normal(name) => {
                !name
                    .to_string_lossy()
                    .trim_end_matches([' ', '.'])
                    .eq_ignore_ascii_case(".git")
                    && !name.to_string_lossy().ends_with([' ', '.'])
            }
            _ => false,
        })
}

fn plain_metadata(path: &Path) -> io::Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other("links cannot be copied or traversed"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other(
                "reparse points cannot be copied or traversed",
            ));
        }
    }
    Ok(metadata)
}

/// Check each directory separately: checking only the leaf would follow an
/// intermediate link. Roots are the backend-confirmed repository identities.
fn plain_parent(root: &Path, relative: &Path, create: bool) -> io::Result<PathBuf> {
    let mut directory = root.to_path_buf();
    if !plain_metadata(&directory)?.is_dir() {
        return Err(io::Error::other("the copy root is not a plain directory"));
    }
    if let Some(parent) = relative.parent() {
        for component in parent.components() {
            directory.push(component);
            if create {
                match fs::create_dir(&directory) {
                    Ok(()) => (),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                    Err(error) => return Err(error),
                }
            }
            if !plain_metadata(&directory)?.is_dir() {
                return Err(io::Error::other("the copy parent is not a plain directory"));
            }
        }
    }
    Ok(directory)
}

fn copy_one(root: &Path, destination_root: &Path, relative: &str) -> io::Result<()> {
    plain_parent(root, Path::new(relative), false)?;
    let source = root.join(relative);
    let metadata = plain_metadata(&source)?;
    if !metadata.is_file() || metadata.len() > MAX_COPY_FILE_BYTES {
        return Err(io::Error::other("the source is not a small regular file"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let source = options.open(&source)?;
    let opened = source.metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("the source changed to a reparse point"));
        }
    }
    if !opened.is_file() {
        return Err(io::Error::other("the source changed before copying"));
    }
    // A file may grow after the size check. Read a bounded snapshot before
    // creating the destination, so oversized sources leave no partial copy.
    let mut content = Vec::new();
    source
        .take(MAX_COPY_FILE_BYTES + 1)
        .read_to_end(&mut content)?;
    if content.len() as u64 > MAX_COPY_FILE_BYTES {
        return Err(io::Error::other("the source is too large to copy"));
    }
    plain_parent(destination_root, Path::new(relative), true)?;
    let mut destination_options = OpenOptions::new();
    destination_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        destination_options.mode(0o600);
    }
    let mut destination = destination_options.open(destination_root.join(relative))?;
    destination.write_all(&content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        destination.set_permissions(fs::Permissions::from_mode(opened.mode() & 0o777))?;
    }
    #[cfg(windows)]
    destination.set_permissions(opened.permissions())?;
    Ok(())
}

/// Lists small ignored files in the repository that can be copied into a new worktree.
pub(super) async fn list_copyable_files(
    git: &GitCommandService,
    repository_path: &Path,
) -> Result<CopyableFiles, ()> {
    let ignored = git
        .list_ignored_paths(repository_path)
        .await
        .map_err(|_| ())?;
    let mut files = Vec::new();
    let mut omitted = 0;
    for entry in ignored {
        if entry.ends_with('/') || !is_plain_relative(&entry) {
            omitted += 1;
            continue;
        }
        if plain_parent(repository_path, Path::new(&entry), false).is_err() {
            omitted += 1;
            continue;
        }
        let Ok(metadata) = plain_metadata(&repository_path.join(&entry)) else {
            continue;
        };
        if !metadata.is_file()
            || metadata.len() > MAX_COPY_FILE_BYTES
            || files.len() >= MAX_LISTED_FILES
        {
            omitted += 1;
            continue;
        }
        files.push((entry, metadata.len()));
    }
    files.sort();
    Ok(CopyableFiles { files, omitted })
}

/// Returns the requested files that are not on the copyable list.
pub(super) async fn rejected_copy_requests(
    git: &GitCommandService,
    repository_path: &Path,
    requested: &[String],
) -> Result<Vec<String>, ()> {
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    let allowed = list_copyable_files(git, repository_path).await?;
    Ok(requested
        .iter()
        .filter(|path| {
            !allowed
                .files
                .iter()
                .any(|(candidate, _)| candidate == *path)
        })
        .cloned()
        .collect())
}

/// Copies the named files into the destination folder, never overwriting. Returns how many were
/// copied and a description of each failure.
pub(super) fn copy_files(
    repository_path: &Path,
    destination_root: &Path,
    files: &[String],
) -> (usize, Vec<String>) {
    let mut copied = 0;
    let mut failures = Vec::new();
    for relative in files {
        if !is_plain_relative(relative) {
            failures.push(format!("{relative}: not a plain relative path"));
            continue;
        }
        let result = copy_one(repository_path, destination_root, relative);
        match result {
            Ok(()) => copied += 1,
            Err(error) => failures.push(format!("{relative}: {error}")),
        }
    }
    (copied, failures)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&destination).unwrap();
        (temp, source, destination)
    }

    #[test]
    fn copies_nested_regular_files_without_overwriting_or_accepting_metadata_paths() {
        let (_temp, source, destination) = fixture();
        fs::create_dir(source.join("config")).unwrap();
        fs::write(source.join("config/app.local"), "secret").unwrap();
        assert_eq!(
            copy_files(&source, &destination, &["config/app.local".into()]),
            (1, vec![])
        );
        fs::write(source.join("config/app.local"), "changed").unwrap();
        assert_eq!(
            copy_files(&source, &destination, &["config/app.local".into()]).0,
            0
        );
        assert_eq!(
            fs::read_to_string(destination.join("config/app.local")).unwrap(),
            "secret"
        );
        for path in [
            "../outside",
            ".git/config",
            ".GIT/config",
            "config/.git/hooks/hook",
            "file:stream",
            "config./file",
        ] {
            assert!(!is_plain_relative(path), "{path}");
        }
    }

    #[test]
    fn changed_source_type_and_size_leave_no_destination_file() {
        let (_temp, source, destination) = fixture();
        fs::create_dir(source.join("directory.local")).unwrap();
        fs::write(
            source.join("large.local"),
            vec![0; MAX_COPY_FILE_BYTES as usize + 1],
        )
        .unwrap();
        let (copied, failures) = copy_files(
            &source,
            &destination,
            &["directory.local".into(), "large.local".into()],
        );
        assert_eq!((copied, failures.len()), (0, 2));
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn eligibility_is_rechecked_after_an_ignored_file_becomes_tracked() {
        let (_temp, source, _destination) = fixture();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(&source)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--quiet"]);
        fs::write(source.join(".gitignore"), "*.local\n").unwrap();
        fs::write(source.join("app.local"), "secret").unwrap();
        let requested = vec!["app.local".into()];
        let commands = GitCommandService::default();
        assert!(rejected_copy_requests(&commands, &source, &requested)
            .await
            .unwrap()
            .is_empty());
        git(&["add", "--force", "app.local"]);
        assert_eq!(
            rejected_copy_requests(&commands, &source, &requested)
                .await
                .unwrap(),
            requested
        );
    }

    fn directory_link(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            // Junction creation needs no developer-mode/symlink privilege.
            let output = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn source_and_destination_directory_links_cannot_escape_the_copy_roots() {
        let (temp, source, destination) = fixture();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("private.local"), "outside secret").unwrap();
        directory_link(&outside, &source.join("linked"));
        let result = copy_files(&source, &destination, &["linked/private.local".into()]);
        assert_eq!(result.0, 0);
        assert!(!destination.join("linked").exists());
        fs::create_dir(source.join("config")).unwrap();
        fs::write(source.join("config/new.local"), "inside").unwrap();
        directory_link(&outside, &destination.join("config"));
        assert_eq!(
            copy_files(&source, &destination, &["config/new.local".into()]).0,
            0
        );
        assert!(!outside.join("new.local").exists());
        // Remove only the fixture's links, leaving their target intact.
        #[cfg(windows)]
        {
            fs::remove_dir(source.join("linked")).unwrap();
            fs::remove_dir(destination.join("config")).unwrap();
        }
        #[cfg(unix)]
        {
            fs::remove_file(source.join("linked")).unwrap();
            fs::remove_file(destination.join("config")).unwrap();
        }
        assert_eq!(
            fs::read_to_string(outside.join("private.local")).unwrap(),
            "outside secret"
        );
    }
}
