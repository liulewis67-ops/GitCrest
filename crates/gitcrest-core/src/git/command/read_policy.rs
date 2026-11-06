use super::*;

impl GitCommandService {
    /// Older Git versions ignore GIT_NO_LAZY_FETCH. Check active promisor
    /// configuration before reading protected objects, then prove the actual
    /// command binaries support the option whose environment equivalent we set.
    pub(crate) async fn verify_local_read_policy(&self, path: &Path) -> Result<(), TaskFailure> {
        let keys = capture_git_output(
            &self.git_program,
            path,
            ["config", "--null", "--name-only", "--list"],
            2 * 1024 * 1024,
        )
        .await?;
        let keys = std::str::from_utf8(&keys).map_err(|_| policy_unavailable())?;
        let mut promisor = false;
        let keys = keys
            .split('\0')
            .filter(|key| !key.is_empty())
            .collect::<std::collections::BTreeSet<_>>();
        for key in keys {
            let normalized = key.to_ascii_lowercase();
            if normalized == "extensions.partialclone" {
                promisor = true;
                break;
            }
            if normalized.starts_with("remote.") && normalized.ends_with(".promisor") {
                let value = capture_git_output(
                    &self.git_program,
                    path,
                    ["config", "--bool", "--get", key],
                    16,
                )
                .await?;
                match std::str::from_utf8(&value)
                    .map(str::trim)
                    .map_err(|_| policy_unavailable())?
                {
                    "true" => {
                        promisor = true;
                        break;
                    }
                    "false" => {}
                    _ => return Err(policy_unavailable()),
                }
            }
        }
        if !promisor {
            return Ok(());
        }
        // Some existing diff/metadata adapters use PATH's Git independently of
        // this service's program. Both must honor the read policy.
        for (index, program) in [self.git_program.as_str(), "git"].into_iter().enumerate() {
            if index == 1 && program == self.git_program {
                continue;
            }
            capture_git_output(program, path, ["--no-lazy-fetch", "--version"], 1024)
                .await
                .map_err(|_| policy_unavailable())?;
        }
        Ok(())
    }
}

fn policy_unavailable() -> TaskFailure {
    TaskFailure::diagnosed(GitFailureCode::PreconditionChanged,
        "This Git cannot guarantee local-only object reads for a promisor repository. Verify its no-lazy-fetch capability before continuing.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as Git;

    fn git(path: &Path, args: &[&str]) -> String {
        let output = Git::new("git")
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
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    #[tokio::test]
    async fn local_read_policy_distinguishes_false_promisor_flags_and_probes_declared_capabilities()
    {
        let repository = crate::features::operations::preview::tests::repository();
        let path = repository.path();
        let commands = GitCommandService::default();
        git(path, &["config", "remote.Inactive.promisor", "false"]);
        assert!(commands.verify_local_read_policy(path).await.is_ok());
        git(path, &["config", "remote.Active.promisor", "true"]);
        let supported = Git::new("git")
            .args(["--no-lazy-fetch", "--version"])
            .output()
            .unwrap()
            .status
            .success();
        assert_eq!(
            commands.verify_local_read_policy(path).await.is_ok(),
            supported
        );
        git(path, &["config", "remote.Active.promisor", "false"]);
        assert!(commands.verify_local_read_policy(path).await.is_ok());
        git(path, &["config", "extensions.partialClone", "Active"]);
        assert_eq!(
            commands.verify_local_read_policy(path).await.is_ok(),
            supported
        );
    }
}
