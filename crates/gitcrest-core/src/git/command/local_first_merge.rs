use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use crate::{domain::workflow::WorkflowOperation, ports::conflicts::ConflictGitPort};

use super::{
    capture_git_output, run_command, status, workflow_command_result, GitCommandService,
    TaskContext, TaskFailure,
};

const MAX_PATH_OUTPUT: usize = 20 * 1024 * 1024;

struct Merge<'a> {
    git: &'a GitCommandService,
    path: &'a Path,
    task: TaskContext,
}

impl GitCommandService {
    pub(in crate::git::command) async fn local_first_merge(
        &self,
        path: &Path,
        target: &str,
        no_fast_forward: bool,
        dirty: bool,
        task: TaskContext,
    ) -> Result<(), TaskFailure> {
        let merge = Merge {
            git: self,
            path,
            task,
        };
        let stash = if dirty {
            merge.save_changes().await?
        } else {
            None
        };
        let result = merge.merge_commits(target, no_fast_forward).await;
        if let Some(stash) = stash {
            if result.is_ok() {
                if let Err(failure) = merge.restore_changes(&stash).await {
                    return Err(failure.with_message(format!(
                        "Merge completed, but local changes could not be fully restored. The backup is in Stashes ({stash})."
                    )));
                }
            } else {
                // Restore after a refused merge only when Git left the original checkout clean.
                let can_restore = status::read_worktree_state(&self.git_program, path)
                    .await
                    .is_ok_and(|state| state.operation.is_none() && state.dirty_paths.is_empty())
                    && matches!(
                        (merge.output(["rev-parse", "HEAD"]).await, merge.output(["rev-parse", &format!("{stash}^1")]).await),
                        (Ok(head), Ok(base)) if head == base
                    );
                if !can_restore || merge.restore_changes(&stash).await.is_err() {
                    merge
                        .task
                        .log(format!("Local changes are backed up in Stashes ({stash})."))
                        .await;
                }
            }
        }
        result
    }
}

impl Merge<'_> {
    async fn output<const N: usize>(&self, args: [&str; N]) -> Result<Vec<u8>, TaskFailure> {
        capture_git_output(&self.git.git_program, self.path, args, MAX_PATH_OUTPUT).await
    }

    async fn run(
        &self,
        args: &[&str],
        input: Option<Vec<u8>>,
        label: &str,
    ) -> Result<(), TaskFailure> {
        run_command(
            &self.git.git_program,
            args.iter().map(|arg| (*arg).into()).collect(),
            None,
            input,
            Vec::new(),
            vec![("GIT_EDITOR".into(), "true".into())],
            Some(self.path),
            label,
            self.task.clone(),
        )
        .await
    }

    async fn merge_commits(&self, target: &str, no_fast_forward: bool) -> Result<(), TaskFailure> {
        let mut args = vec![
            "merge",
            "--no-edit",
            "--no-autostash",
            "--no-overwrite-ignore",
            "-s",
            "ort",
            "-Xours",
        ];
        if no_fast_forward {
            args.push("--no-ff");
        }
        args.extend(["--", target]);
        let result = self.run(&args, None, "Merge commit").await;
        let result = match result {
            Err(failure)
                if !matches!(failure, TaskFailure::Cancelled)
                    && matches!(
                        status::read_operation(&self.git.git_program, self.path).await,
                        Ok(Some(WorkflowOperation::Merge))
                    ) =>
            {
                match self.output(["ls-files", "--unmerged", "-z"]).await {
                    Ok(conflicts) if !conflicts.is_empty() => {
                        self.resolve_conflicts(&conflicts).await
                    }
                    _ => Err(failure),
                }
            }
            result => result,
        };
        workflow_command_result(&self.git.git_program, self.path, result).await
    }

    async fn resolve_conflicts(&self, output: &[u8]) -> Result<(), TaskFailure> {
        let invalid =
            || TaskFailure::command_failed("Git returned an invalid unmerged path".into());
        let mut paths = BTreeMap::new();
        for record in output
            .split(|&byte| byte == 0)
            .filter(|record| !record.is_empty())
        {
            let (header, path) = std::str::from_utf8(record)
                .ok()
                .and_then(|record| record.split_once('\t'))
                .ok_or_else(invalid)?;
            let local = header.ends_with(" 2");
            // A gitlink needs its own resolution. Git may also relocate the
            // local file in a file/directory conflict, leaving stage 2 at a
            // synthetic path. Staging that path would commit the relocated file.
            if header.starts_with("160000 ")
                || (local
                    && self
                        .output(["cat-file", "-e", &format!("HEAD:{path}")])
                        .await
                        .is_err())
            {
                return Err(TaskFailure::command_failed(format!(
                    "Could not automatically resolve the merge at {path}"
                )));
            }
            *paths.entry(path).or_insert(false) |= local;
        }
        for (path, has_local_version) in paths {
            self.git
                .resolve_conflict_side(self.path, path, 2, has_local_version)
                .await
                .map_err(|_| {
                    TaskFailure::command_failed(format!(
                        "Could not keep the local version of {path}"
                    ))
                })?;
        }
        self.run(&["merge", "--continue"], None, "Complete merge")
            .await
    }

    async fn save_changes(&self) -> Result<Option<String>, TaskFailure> {
        let message = format!("GitCrest merge {}", self.task.task_id());
        self.run(
            &["stash", "push", "--include-untracked", "-m", &message],
            None,
            "Save local changes",
        )
        .await?;
        let entries = self.output(["stash", "list", "--format=%H %gs"]).await?;
        let suffix = format!(": {message}");
        let stash = String::from_utf8_lossy(&entries).lines().find_map(|entry| {
            let (oid, subject) = entry.split_once(' ')?;
            subject.ends_with(&suffix).then(|| oid.to_owned())
        });
        if let Some(stash) = &stash {
            self.task
                .log(format!("Saved local changes in Stashes ({stash})."))
                .await;
        }
        Ok(stash)
    }

    async fn changed_paths(&self, from: &str, to: &str) -> Result<BTreeSet<Vec<u8>>, TaskFailure> {
        let output = self
            .output(["diff", "--name-only", "-z", "--no-renames", from, to, "--"])
            .await?;
        Ok(split_paths(&output).map(<[u8]>::to_vec).collect())
    }

    async fn restore_changes(&self, stash: &str) -> Result<(), TaskFailure> {
        let base = format!("{stash}^1");
        let index = format!("{stash}^2");
        let untracked = format!("{stash}^3");
        let staged_paths = self.changed_paths(&base, &index).await?;
        let mut worktree_paths = self.changed_paths(&base, stash).await?;
        worktree_paths.extend(staged_paths.iter().cloned());
        let worktree_diff = self.changed_paths("HEAD", stash).await?;
        let index_diff = self.changed_paths("HEAD", &index).await?;
        let untracked_paths = self
            .output(["ls-tree", "-r", "--name-only", "-z", &untracked])
            .await?;

        // Restore only paths that had local changes. Use separate snapshots for the index
        // and worktree so partially staged files keep both versions.
        self.restore_paths(
            stash,
            "--worktree",
            worktree_paths
                .intersection(&worktree_diff)
                .map(Vec::as_slice),
        )
        .await?;
        self.restore_paths(
            &index,
            "--staged",
            staged_paths.intersection(&index_diff).map(Vec::as_slice),
        )
        .await?;
        self.restore_paths(&untracked, "--worktree", split_paths(&untracked_paths))
            .await?;

        let is_top = self
            .output(["stash", "list", "-1", "--format=%H"])
            .await
            .is_ok_and(|top| String::from_utf8_lossy(&top).trim_end() == stash);
        if !is_top
            || self
                .run(&["stash", "drop", "stash@{0}"], None, "Remove merge backup")
                .await
                .is_err()
        {
            self.task
                .log(format!(
                    "Local changes were restored. The backup was left in Stashes ({stash})."
                ))
                .await;
        }
        Ok(())
    }

    async fn restore_paths<'a>(
        &self,
        source: &str,
        destination: &str,
        paths: impl Iterator<Item = &'a [u8]>,
    ) -> Result<(), TaskFailure> {
        let input: Vec<u8> = paths
            .flat_map(|path| path.iter().copied().chain([0]))
            .collect();
        if input.is_empty() {
            return Ok(());
        }
        self.run(
            &[
                "--literal-pathspecs",
                "restore",
                "--source",
                source,
                destination,
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Some(input),
            "Restore local changes",
        )
        .await
    }
}

fn split_paths(output: &[u8]) -> impl Iterator<Item = &[u8]> {
    output
        .split(|&byte| byte == 0)
        .filter(|path| !path.is_empty())
}
