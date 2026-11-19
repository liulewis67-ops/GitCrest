use std::path::Path;

use crate::{
    domain::{diff::DiffDocument, status::ChangeKind},
    features::diff::{document_from_patch, DiffError},
    git::diff::read_patch_numstat,
};

/// Resolve quoted Git paths from the stored patch, then read only the selected file's hunks.
pub(super) async fn read_file(
    repository_path: &Path,
    patch: &[u8],
    repo_id: String,
    path: &str,
) -> Result<DiffDocument, DiffError> {
    let stats = read_patch_numstat(repository_path, patch).await?;
    let records: Vec<_> = stats
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect();
    let mut boundaries = Vec::new();
    let mut offset = 0;
    for line in patch.split_inclusive(|byte| *byte == b'\n') {
        if line.starts_with(b"diff --git ") {
            boundaries.push(offset);
        }
        offset += line.len();
    }
    if boundaries.len() != records.len() {
        return Err(DiffError::GitFailed);
    }
    boundaries.push(patch.len());

    let mut selected = Vec::new();
    let mut kind = ChangeKind::Modified;
    for (record, bounds) in records.into_iter().zip(boundaries.windows(2)) {
        let changed_path = record
            .splitn(3, |byte| *byte == b'\t')
            .nth(2)
            .ok_or(DiffError::GitFailed)?;
        if String::from_utf8_lossy(changed_path) != path {
            continue;
        }
        let file_patch = &patch[bounds[0]..bounds[1]];
        kind = file_patch
            .split(|byte| *byte == b'\n')
            .take_while(|line| !line.starts_with(b"@@ ") && *line != b"GIT binary patch")
            .find_map(|line| {
                [
                    (b"new file mode ".as_slice(), ChangeKind::Added),
                    (b"deleted file mode ".as_slice(), ChangeKind::Deleted),
                    (b"rename to ".as_slice(), ChangeKind::Renamed),
                    (b"copy to ".as_slice(), ChangeKind::Copied),
                ]
                .into_iter()
                .find_map(|(prefix, kind)| line.starts_with(prefix).then_some(kind))
            })
            .unwrap_or(ChangeKind::Modified);
        selected.extend_from_slice(file_patch);
    }
    if selected.is_empty() {
        return Err(DiffError::PathNotFound);
    }
    let mut document = document_from_patch(repo_id, path, &selected);
    document.change_kind = kind;
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::diff::DiffContentStatus;

    #[tokio::test]
    async fn isolates_saved_hunks_by_exact_git_path() {
        let repo = tempfile::tempdir().unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "--quiet", "--object-format=sha256"])
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success());
        let patch = br#"diff --git a/Bin path.bin b/Bin path.bin
index 805430b6f9b0cdd2a9003148a98a96599cbb181131d1e640cbb7cb1a5e83f470..73a6789080c7b41e9cc79e70b1ed89b358b0060ab11f6aa0b422ced882b28f99 100644
GIT binary patch
literal 6
NcmZQbOe;w(0ssaZ0uulL

literal 7
OcmZQbN=?fzN(BH2dIEF+

diff --git a/neighbor.txt b/neighbor.txt
--- a/neighbor.txt
+++ b/neighbor.txt
@@ -1 +1 @@
-before
+neighbor
diff --git "a/src/\344\277\235\345\255\230 note.txt" "b/src/\344\277\235\345\255\230 note.txt"
new file mode 100644
--- /dev/null
+++ "b/src/\344\277\235\345\255\230 note.txt"
@@ -0,0 +1 @@
+saved
diff --git a/with spaces.txt b/with spaces.txt
--- a/with spaces.txt
+++ b/with spaces.txt
@@ -1 +1 @@
-old
+new
"#;
        let read = |path| read_file(repo.path(), patch, "repo_fixture".into(), path);
        let doc = read("src/保存 note.txt").await.unwrap();
        assert_eq!(doc.change_kind, ChangeKind::Added);
        assert_eq!(doc.status, DiffContentStatus::Text);
        assert_eq!(doc.hunks.len(), 1);
        assert_eq!(doc.hunks[0].rows[0].new_text.as_deref(), Some("saved"));
        let doc = read("with spaces.txt").await.unwrap();
        assert_eq!(doc.hunks[0].rows[0].new_text.as_deref(), Some("new"));
        let doc = read("Bin path.bin").await.unwrap();
        assert_eq!(doc.status, DiffContentStatus::Binary);
        assert_eq!(read("note.txt").await.unwrap_err(), DiffError::PathNotFound);
    }
}
