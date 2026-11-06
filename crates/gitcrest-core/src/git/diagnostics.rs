use std::ffi::OsString;

use crate::domain::git_result::GitFailureCode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CommandKind {
    Checkout,
    Integrate,
    Push,
    Other,
}

impl CommandKind {
    pub(super) fn from_arguments(arguments: &[OsString]) -> Self {
        let mut arguments = arguments.iter();
        while let Some(argument) = arguments.next() {
            let argument = argument.to_string_lossy();
            if matches!(argument.as_ref(), "-c" | "-C" | "--git-dir" | "--work-tree") {
                arguments.next();
                continue;
            }
            if argument.starts_with('-') {
                continue;
            }
            return match argument.as_ref() {
                "checkout" | "switch" => Self::Checkout,
                "merge" | "pull" | "rebase" | "cherry-pick" | "revert" => Self::Integrate,
                "push" => Self::Push,
                _ => Self::Other,
            };
        }
        Self::Other
    }
}

/// Observes bounded diagnostic records before the presentation log can discard them.
/// Conflicts require an independent repository-state check and are never inferred here.
#[derive(Default)]
pub(super) struct OutputDiagnostics {
    pub(super) failure_code: Option<GitFailureCode>,
    pub(super) truncated: bool,
    pub(super) incomplete: bool,
}

impl OutputDiagnostics {
    pub(super) fn observe_push_status(&mut self, record: &[u8]) {
        let record = String::from_utf8_lossy(record);
        let mut fields = record.splitn(3, '\t');
        if fields.next() != Some("!") || !fields.next().is_some_and(|refs| refs.contains(':')) {
            return;
        }
        let Some(summary) = fields.next() else {
            return;
        };
        // --porcelain ref status is emitted on stdout; remote hook chatter is not this format.
        self.observe(CommandKind::Push, summary.as_bytes());
    }

    pub(super) fn observe(&mut self, kind: CommandKind, line: &[u8]) {
        let line = String::from_utf8_lossy(line).to_ascii_lowercase();
        let line = line.trim();
        // Remote hooks can print arbitrary text; only the local Git diagnostic is evidence.
        if line.starts_with("remote:") {
            return;
        }
        let code = if line.contains("authentication failed")
            || line.contains("could not read username")
            || line.contains("could not read password")
            || line.contains("permission denied (publickey)")
        {
            Some(GitFailureCode::AuthenticationFailed)
        } else if line.contains("could not resolve host")
            || line.contains("failed to connect")
            || line.contains("connection timed out")
            || line.contains("network is unreachable")
        {
            Some(GitFailureCode::Network)
        } else if matches!(kind, CommandKind::Checkout | CommandKind::Integrate)
            && line.contains("untracked working tree files would be overwritten")
        {
            Some(GitFailureCode::UntrackedFilesWouldBeOverwritten)
        } else if matches!(kind, CommandKind::Checkout | CommandKind::Integrate)
            && line.contains("local changes to the following files would be overwritten")
        {
            Some(GitFailureCode::LocalChangesWouldBeOverwritten)
        } else if kind == CommandKind::Push
            && line.contains("[rejected]")
            && line.contains("stale info")
        {
            Some(GitFailureCode::LeaseStale)
        } else if kind == CommandKind::Push && line.contains("[remote rejected]") {
            Some(GitFailureCode::RemotePolicyRejected)
        } else if kind == CommandKind::Push
            && line.contains("[rejected]")
            && (line.contains("non-fast-forward") || line.contains("fetch first"))
        {
            Some(GitFailureCode::PushRejected)
        } else {
            None
        };
        if let Some(code) = code {
            self.failure_code = Some(match self.failure_code {
                None => code,
                Some(previous) if previous == code => code,
                // Several refs can have different outcomes; do not claim a single reason.
                Some(_) => GitFailureCode::CommandFailed,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_scope_and_remote_messages_cannot_invent_a_conflict_or_lease() {
        let mut diagnostics = OutputDiagnostics::default();
        diagnostics.observe(
            CommandKind::Other,
            b"CONFLICT (content): Merge conflict in file.txt",
        );
        diagnostics.observe(
            CommandKind::Other,
            b"! [rejected] main -> main (stale info)",
        );
        diagnostics.observe(
            CommandKind::Push,
            b"remote: Authentication failed in the test suite",
        );
        assert_eq!(diagnostics.failure_code, None);
        diagnostics.observe(CommandKind::Push, b"! [rejected] main -> main (stale info)");
        assert_eq!(diagnostics.failure_code, Some(GitFailureCode::LeaseStale));
    }

    #[test]
    fn skips_global_option_values_when_identifying_the_command() {
        let args = ["-c", "push", "-C", "checkout", "pull", "origin", "main"].map(OsString::from);
        assert_eq!(CommandKind::from_arguments(&args), CommandKind::Integrate);
    }

    #[test]
    fn push_porcelain_ref_status_has_a_separate_stdout_parser() {
        let mut diagnostics = OutputDiagnostics::default();
        diagnostics
            .observe_push_status(b"!\trefs/heads/main:refs/heads/main\t[rejected] (stale info)");
        assert_eq!(diagnostics.failure_code, Some(GitFailureCode::LeaseStale));
        diagnostics.observe_push_status(
            b"!\trefs/heads/tag:refs/heads/tag\t[remote rejected] (hook declined)",
        );
        assert_eq!(
            diagnostics.failure_code,
            Some(GitFailureCode::CommandFailed)
        );
    }
}
