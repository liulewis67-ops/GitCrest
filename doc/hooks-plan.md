# Repository Hooks

Status: implemented; desktop regression limitations recorded below. Date: 2026-11-03.

Reuse the persisted pipeline engine as repository Hooks. Keep existing API paths,
events, SQLite JSON records and `.gitcrest/pipelines.json` compatible.

- Events: `afterPush` and `afterCommit` (including amend), filtered by branch glob.
  Only successful operations initiated through GitCrest emit events. Detached commits do not match.
- Operations: ordered merge/push targets followed by ordered custom commands.
  Each command specifies a program, argument array and timeout (1–3600 seconds).
  Commands run in the repository root without implicit shell parsing. Scripts can explicitly invoke a shell.
- Context: `GITCREST_EVENT`, `GITCREST_BRANCH`, `GITCREST_COMMIT`, `GITCREST_REPO_ID` environment variables.
- Old rules default to an empty command list; no SQL migration is required.
- Reuse enable/disable, confirmation, branch preview, import review and durable runs.
- Record command exit results, stop subsequent commands on failure, and require explicit retry after interruption.
- Custom commands use the repository root regardless of merge workspace mode, after target workspaces are cleaned up.
- Runs with custom commands pause application branch operations while running, because commands use the repository root.
- Hook subprocesses do not recursively emit app events. Hook errors do not undo the triggering operation.

Implementation: domain/API and event dispatch → command execution and persisted steps →
editor and run UI with English/Chinese copy → compatibility, event isolation, command
ordering/failure/timeout tests and repository checks.


## Usage

Open Settings → Automations → Add rule. Choose After commit or After push,
set a branch pattern, and add merge targets and/or custom commands. Commands can
be moved up to change their order. Choose confirmation or automatic execution.

For a Node script, use program `node`, arguments `["scripts/after-commit.mjs"]`
and a timeout such as 300 seconds. The script can read `process.env.GITCREST_COMMIT`
and `process.env.GITCREST_BRANCH`. For a PowerShell script, use program `pwsh`
and arguments `["-NoProfile", "-File", "scripts/after-push.ps1"]`.

Commands run against the repository working directory as it exists at execution
time; the environment commit id identifies the triggering commit. Stdout/stderr
are not retained; scripts can write their own log files. After an interrupted
command, review any side effects before choosing Run this operation again.

The execution-mode setting controls merge target workspaces. Custom commands
always use the original repository root. Imported rules require review and ask
before running; existing after-push rules retain their behavior.


## Verification (2026-11-03)

- Frontend import boundaries, app/test TypeScript checks and production build passed.
- Rust formatting and Clippy with all targets and warnings denied passed.
- All 342 Rust tests passed, including failed/successful commit API dispatch,
  old JSON compatibility, event isolation, command ordering, failure, timeout and repository holds.
- Frontend unit suite: 792/793 passed on the first full run; the website demo test
  exceeded its 30-second timeout and passed when rerun alone. All 793 cases have passed.
- Full desktop E2E: 53 passed, 4 failed (19 files). Both pipeline workspace modes passed.
  The failures were external-merge adoption and shelf apply (the Task Center backdrop
  intercepted a helper click), clone cancellation (missing Tasks/Refresh locator),
  and desktop dirty switching (expects the obsolete text "May be overwritten";
  HEAD already uses "May need conflict resolution"). These tests and their helper
  were not changed for Hooks. The suite is not reported as green.
- Focused rerun: external-merge adoption passed; clone cancellation and shelf apply
  reproduced the same locator/backdrop failures. Desktop startup was not rerun
  because its expected literal is demonstrably stale in HEAD. Three desktop
  regression failures remain outside the Hook implementation.

The user's pre-existing working-tree changes are kept separate from the Hook changes.
