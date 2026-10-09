use std::{path::Path, process::Stdio};

use git2::{Delta, DiffDelta, Repository, Status, StatusOptions, StatusShow};
use tokio::process::Command;

use crate::domain::status::{ChangeCategory, ChangeKind, StatusFile, StatusSnapshot};

pub(super) async fn read_status(
    repo_id: String,
    path: &Path,
    paths: &[String],
) -> Result<StatusSnapshot, std::io::Error> {
    read_scope(repo_id, path, paths).await
}

async fn read_scope(
    repo_id: String,
    path: &Path,
    paths: &[String],
) -> Result<StatusSnapshot, std::io::Error> {
    let native_path = path.to_owned();
    let native_files = tokio::task::spawn_blocking(move || read_libgit2(&native_path))
        .await
        .map_err(|_| std::io::Error::other("Git status worker failed"))?;
    let files = match native_files {
        Ok(Some(files)) => filter_paths(files, paths),
        Ok(None) | Err(_) => read_git_cli(path, paths).await?,
    };

    Ok(StatusSnapshot {
        repo_id,
        refreshed_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64,
        files,
    })
}

fn read_libgit2(path: &Path) -> Result<Option<Vec<StatusFile>>, git2::Error> {
    let repo = Repository::open(path)?;
    let mut options = StatusOptions::new();
    options
        .show(StatusShow::IndexAndWorkdir)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(true)
        .recurse_ignored_dirs(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .update_index(false);

    let statuses = repo.statuses(Some(&mut options))?;
    let mut files = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let status = entry.status();
        // Porcelain v2 carries the exact conflict stages and unreadable-file
        // status. Preserve those less common details with Git's formatter.
        if status.intersects(Status::CONFLICTED | Status::WT_UNREADABLE) {
            return Ok(None);
        }
        if let Some(file) = convert_status_entry(&entry) {
            files.push(file);
        }
    }
    Ok(Some(files))
}

fn convert_status_entry(entry: &git2::StatusEntry<'_>) -> Option<StatusFile> {
    let status = entry.status();
    let index_delta = entry.head_to_index();
    let worktree_delta = entry.index_to_workdir();
    let index_status = delta_status(index_delta.as_ref());
    let worktree_status = delta_status(worktree_delta.as_ref());

    if status.contains(Status::IGNORED) {
        return Some(StatusFile {
            path: status_path(entry.path_bytes()),
            original_path: None,
            index_status: "!".into(),
            worktree_status: "!".into(),
            kind: ChangeKind::Ignored,
            categories: vec![ChangeCategory::Ignored],
            mode_changed: false,
        });
    }

    if status.contains(Status::WT_NEW) && index_status == '.' {
        return Some(StatusFile {
            path: status_path(entry.path_bytes()),
            original_path: None,
            index_status: "?".into(),
            worktree_status: "?".into(),
            kind: ChangeKind::Untracked,
            categories: vec![ChangeCategory::Untracked],
            mode_changed: false,
        });
    }

    let index_rename = index_delta
        .as_ref()
        .filter(|delta| delta.status() == Delta::Renamed);
    let worktree_rename = worktree_delta
        .as_ref()
        .filter(|delta| delta.status() == Delta::Renamed);
    let rename = worktree_rename.or(index_rename);
    let path = rename
        .and_then(|delta| delta.new_file().path_bytes())
        .or_else(|| {
            worktree_delta
                .as_ref()
                .and_then(|delta| delta.new_file().path_bytes())
        })
        .or_else(|| {
            index_delta
                .as_ref()
                .and_then(|delta| delta.new_file().path_bytes())
        })
        .unwrap_or_else(|| entry.path_bytes());
    let original_path = rename
        .and_then(|delta| delta.old_file().path_bytes())
        .map(status_path);
    let mut categories = Vec::new();
    if index_status != '.' {
        categories.push(ChangeCategory::Staged);
    }
    if worktree_status != '.' {
        categories.push(ChangeCategory::Unstaged);
    }
    let mode_changed = index_delta
        .as_ref()
        .is_some_and(|delta| delta.old_file().mode() != delta.new_file().mode())
        || worktree_delta
            .as_ref()
            .is_some_and(|delta| delta.old_file().mode() != delta.new_file().mode());

    Some(StatusFile {
        path: status_path(path),
        original_path,
        index_status: index_status.to_string(),
        worktree_status: worktree_status.to_string(),
        kind: change_kind(index_status, worktree_status),
        categories,
        mode_changed,
    })
}

fn delta_status(delta: Option<&DiffDelta<'_>>) -> char {
    match delta.map(DiffDelta::status) {
        Some(Delta::Added) => 'A',
        Some(Delta::Modified) => 'M',
        Some(Delta::Deleted) => 'D',
        Some(Delta::Renamed) => 'R',
        Some(Delta::Copied) => 'C',
        Some(Delta::Typechange) => 'T',
        Some(Delta::Unmodified) | None => '.',
        Some(Delta::Ignored | Delta::Untracked | Delta::Unreadable | Delta::Conflicted) => '?',
    }
}

fn status_path(path: &[u8]) -> String {
    String::from_utf8_lossy(path).into_owned()
}

fn filter_paths(mut files: Vec<StatusFile>, paths: &[String]) -> Vec<StatusFile> {
    if paths.is_empty() {
        return files;
    }
    files.retain(|file| {
        paths.iter().any(|path| {
            path_matches(&file.path, path)
                || file
                    .original_path
                    .as_deref()
                    .is_some_and(|original| path_matches(original, path))
        })
    });
    files
}

fn path_matches(file_path: &str, requested_path: &str) -> bool {
    let file_path = file_path.trim_end_matches('/');
    let requested_path = requested_path.replace('\\', "/");
    let requested_path = requested_path.trim_end_matches('/');
    requested_path == "."
        || file_path == requested_path
        || file_path
            .strip_prefix(requested_path)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || requested_path
            .strip_prefix(file_path)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

async fn read_git_cli(path: &Path, paths: &[String]) -> Result<Vec<StatusFile>, std::io::Error> {
    let mut command = Command::new("git");
    command
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(path)
        .args([
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if !paths.is_empty() {
        command.arg("--").args(paths);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "Git status timed out"))??;
    if !output.status.success() {
        return Err(std::io::Error::other("Git status failed"));
    }
    Ok(parse_porcelain_v2(&output.stdout))
}

fn parse_porcelain_v2(output: &[u8]) -> Vec<StatusFile> {
    let output = String::from_utf8_lossy(output);
    let mut records = output
        .split('\0')
        .filter(|record| !record.is_empty())
        .peekable();
    let mut files = Vec::new();

    while let Some(record) = records.next() {
        if record.starts_with("2 ") {
            if let Some(original_path) = records.next() {
                if let Some(file) = parse_record(record, Some(original_path.to_owned())) {
                    files.push(file);
                }
            }
        } else if let Some(file) = parse_record(record, None) {
            files.push(file);
        }
    }
    files
}

fn parse_record(record: &str, original_path: Option<String>) -> Option<StatusFile> {
    let (kind_tag, status, mode_changed, path) = match record.as_bytes().first().copied()? {
        b'1' => {
            let fields = record.splitn(9, ' ').collect::<Vec<_>>();
            if fields.len() != 9 {
                return None;
            }
            (
                fields[0],
                fields[1],
                fields[3] != fields[4] || fields[4] != fields[5],
                fields[8],
            )
        }
        b'2' => {
            let fields = record.splitn(10, ' ').collect::<Vec<_>>();
            if fields.len() != 10 {
                return None;
            }
            (
                fields[0],
                fields[1],
                fields[3] != fields[4] || fields[4] != fields[5],
                fields[9],
            )
        }
        b'u' => {
            let fields = record.splitn(11, ' ').collect::<Vec<_>>();
            if fields.len() != 11 {
                return None;
            }
            (
                fields[0],
                fields[1],
                fields[3] != fields[4] || fields[4] != fields[5] || fields[5] != fields[6],
                fields[10],
            )
        }
        b'?' => {
            return Some(special_file(
                record,
                ChangeKind::Untracked,
                ChangeCategory::Untracked,
            ))
        }
        b'!' => {
            return Some(special_file(
                record,
                ChangeKind::Ignored,
                ChangeCategory::Ignored,
            ))
        }
        _ => return None,
    };

    let mut status_chars = status.chars();
    let index_status = status_chars.next().unwrap_or('.');
    let worktree_status = status_chars.next().unwrap_or('.');
    let conflicted = kind_tag == "u" || status.contains('U');
    let kind = if conflicted {
        ChangeKind::Conflicted
    } else {
        change_kind(index_status, worktree_status)
    };
    let mut categories = Vec::new();
    if conflicted {
        categories.push(ChangeCategory::Conflicted);
    } else {
        if index_status != '.' {
            categories.push(ChangeCategory::Staged);
        }
        if worktree_status != '.' {
            categories.push(ChangeCategory::Unstaged);
        }
    }

    Some(StatusFile {
        path: path.to_owned(),
        original_path,
        index_status: index_status.to_string(),
        worktree_status: worktree_status.to_string(),
        kind,
        categories,
        mode_changed,
    })
}

fn special_file(record: &str, kind: ChangeKind, category: ChangeCategory) -> StatusFile {
    StatusFile {
        path: record.get(2..).unwrap_or_default().to_owned(),
        original_path: None,
        index_status: if category == ChangeCategory::Untracked {
            "?"
        } else {
            "!"
        }
        .into(),
        worktree_status: if category == ChangeCategory::Untracked {
            "?"
        } else {
            "!"
        }
        .into(),
        kind,
        categories: vec![category],
        mode_changed: false,
    }
}

fn change_kind(index: char, worktree: char) -> ChangeKind {
    let statuses = [index, worktree];
    if statuses.contains(&'R') {
        ChangeKind::Renamed
    } else if statuses.contains(&'C') {
        ChangeKind::Copied
    } else if statuses.contains(&'D') {
        ChangeKind::Deleted
    } else if statuses.contains(&'T') {
        ChangeKind::TypeChanged
    } else if statuses.contains(&'A') {
        ChangeKind::Added
    } else {
        ChangeKind::Modified
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command as ProcessCommand;
    use tempfile::tempdir;

    fn git(root: &Path, args: &[&str]) {
        let output = ProcessCommand::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn sorted(files: Vec<StatusFile>) -> Vec<StatusFile> {
        let mut files = files;
        files.sort_by(|left, right| left.path.cmp(&right.path));
        files
    }

    #[test]
    fn status_scope_rejects_nul_and_matches_repository_dot() {
        assert_eq!(
            crate::features::status::scope::validate_paths(&["bad\0path".into()])
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert!(path_matches("nested/file.txt", "."));
    }

    #[test]
    fn parses_porcelain_v2_groups_renames_conflicts_and_mode_changes() {
        let records = concat!(
            "1 M. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 both.txt\0",
            "2 R. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R100 renamed.txt\0old name.txt\0",
            "u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 conflict.txt\0",
            "1 M. N... 100644 100755 100755 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 executable.sh\0",
            "? new file.txt\0",
            "! ignored.log\0",
        );
        let files = parse_porcelain_v2(records.as_bytes());

        assert_eq!(files.len(), 6);
        assert_eq!(files[0].categories, [ChangeCategory::Staged]);
        assert_eq!(files[1].kind, ChangeKind::Renamed);
        assert_eq!(files[1].original_path.as_deref(), Some("old name.txt"));
        assert_eq!(files[2].kind, ChangeKind::Conflicted);
        assert_eq!(files[2].categories, [ChangeCategory::Conflicted]);
        assert!(files[3].mode_changed);
        assert_eq!(files[4].categories, [ChangeCategory::Untracked]);
        assert_eq!(files[5].categories, [ChangeCategory::Ignored]);
    }

    #[tokio::test]
    async fn libgit2_status_matches_git_for_renames_untracked_and_ignored_files() {
        let root = tempdir().unwrap();
        git(root.path(), &["init", "--quiet"]);
        git(root.path(), &["config", "user.name", "GitCrest Test"]);
        git(
            root.path(),
            &["config", "user.email", "gitcrest@example.invalid"],
        );
        fs::create_dir_all(root.path().join("tracked-nested")).unwrap();
        fs::write(root.path().join("tracked.txt"), "base\n").unwrap();
        fs::write(root.path().join("staged.txt"), "base\n").unwrap();
        fs::write(root.path().join("delete-me.txt"), "base\n").unwrap();
        fs::write(root.path().join("rename-old.txt"), "rename\n").unwrap();
        fs::write(root.path().join("tracked-nested/child.txt"), "child\n").unwrap();
        fs::write(root.path().join(".gitignore"), "*.ignored\nignored-dir/\n").unwrap();
        git(root.path(), &["add", "."]);
        git(root.path(), &["commit", "--quiet", "-m", "initial"]);

        fs::write(root.path().join("tracked.txt"), "unstaged change\n").unwrap();
        fs::write(root.path().join("staged.txt"), "staged change\n").unwrap();
        git(root.path(), &["add", "staged.txt"]);
        fs::remove_file(root.path().join("delete-me.txt")).unwrap();
        fs::create_dir_all(root.path().join("untracked-dir/deep")).unwrap();
        fs::write(root.path().join("untracked-dir/deep/new.txt"), "new\n").unwrap();
        fs::write(root.path().join("visible.ignored"), "ignored\n").unwrap();
        fs::create_dir_all(root.path().join("ignored-dir/deep")).unwrap();
        fs::write(root.path().join("ignored-dir/deep/inside.txt"), "ignored\n").unwrap();
        git(root.path(), &["mv", "rename-old.txt", "rename-new.txt"]);

        let native = sorted(read_libgit2(root.path()).unwrap().unwrap());
        let cli = sorted(read_git_cli(root.path(), &[]).await.unwrap());
        assert_eq!(native, cli);

        let renamed = native
            .iter()
            .find(|file| file.path == "rename-new.txt")
            .unwrap();
        assert_eq!(renamed.original_path.as_deref(), Some("rename-old.txt"));
        assert_eq!(renamed.index_status, "R");
        assert_eq!(renamed.categories, [ChangeCategory::Staged]);

        let paths = vec!["untracked-dir".to_owned()];
        let filtered = sorted(filter_paths(native.clone(), &paths));
        let scoped_cli = sorted(read_git_cli(root.path(), &paths).await.unwrap());
        assert_eq!(filtered, scoped_cli, "scope {paths:?}");

        // A complete status pass retains rename identity when the requested
        // path only names the new side; a Git pathspec status sees an add.
        let renamed_scope = filter_paths(native, &["rename-new.txt".into()]);
        assert_eq!(renamed_scope.len(), 1);
        assert_eq!(renamed_scope[0].kind, ChangeKind::Renamed);
        assert_eq!(
            renamed_scope[0].original_path.as_deref(),
            Some("rename-old.txt")
        );
    }

    #[tokio::test]
    async fn libgit2_conflicts_fall_back_to_porcelain_stage_details() {
        let root = tempdir().unwrap();
        git(root.path(), &["init", "--quiet"]);
        git(root.path(), &["config", "user.name", "GitCrest Test"]);
        git(
            root.path(),
            &["config", "user.email", "gitcrest@example.invalid"],
        );
        fs::write(root.path().join("conflict.txt"), "base\n").unwrap();
        git(root.path(), &["add", "conflict.txt"]);
        git(root.path(), &["commit", "--quiet", "-m", "initial"]);
        git(root.path(), &["checkout", "--quiet", "-b", "other"]);
        fs::write(root.path().join("conflict.txt"), "other\n").unwrap();
        git(root.path(), &["commit", "--quiet", "-am", "other change"]);
        git(root.path(), &["checkout", "--quiet", "-"]);
        fs::write(root.path().join("conflict.txt"), "main\n").unwrap();
        git(root.path(), &["commit", "--quiet", "-am", "main change"]);
        let output = ProcessCommand::new("git")
            .arg("-C")
            .arg(root.path())
            .args(["merge", "other"])
            .output()
            .unwrap();
        assert!(!output.status.success());

        assert!(read_libgit2(root.path()).unwrap().is_none());
        let via_status_service = read_scope("repo-test".into(), root.path(), &[])
            .await
            .unwrap()
            .files;
        assert_eq!(
            via_status_service,
            read_git_cli(root.path(), &[]).await.unwrap()
        );
        assert_eq!(via_status_service[0].index_status, "U");
        assert_eq!(via_status_service[0].worktree_status, "U");
    }
}
