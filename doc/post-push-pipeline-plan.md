# Post-Push Pipeline Plan

Status: implemented (A0.1 to A4.3 done). Date: 2026-10-31.
Scope: user-defined automations that run after a successful push, starting with "merge the pushed branch into one or more integration branches and push them" (`crates/gitcrest-core/`, `src/`, `doc/api/v1.yaml`).
Related: [12-git-engine-architecture.md](12-git-engine-architecture.md) (tasks and locks), [conflict-resolver-enhancement-plan.md](conflict-resolver-enhancement-plan.md) (conflict window), [07-interaction-accessibility.md](07-interaction-accessibility.md) (safety rules), [13-implementation-plan.md](13-implementation-plan.md) (ledger and commit rules).

## 1. Goal

A user pushes `feature/1`. GitCrest then, without further clicks:

1. brings `uat` up to the latest remote state,
2. merges `feature/1` into `uat`,
3. opens the conflict window if the merge conflicts and waits for the user,
4. pushes `uat`,
5. repeats for the next target (for example `dev`),
6. leaves the user on `feature/1`, as before.

The user decides which branches trigger the pipeline, which targets it merges into and in what order, and how it behaves on conflicts and confirmation.

Non-goals for v1: arbitrary shell steps, triggers other than push (commit, PR merged, schedule), rebasing targets, and automatically reverting pushed integration branches.

## 2. Facts that shape the plan

| Asset | Where | Consequence |
| --- | --- | --- |
| Tasks run behind a per-resource lock and a worker semaphore, and can end in `WaitingForInput` | `crates/gitcrest-core/src/execution/scheduler.rs`, `execution/locks.rs`, `domain/task.rs` | Each pipeline step can be an ordinary task. A pipeline in a temporary worktree uses its own resource key and does not block the main repository. |
| Merge is a task (`execute_workflow`) with preflight and an expected-HEAD guard; conflicts end the task in `WaitingForInput` | `features/workflows/handlers/merge.rs`, `features/workflows/service.rs` | The merge step reuses it unchanged, except for an optional commit message (see A2.1). |
| Recovery continue / skip / abort exists | `features/workflows/handlers/recovery.rs`, route `/workflows/recovery` | The pipeline resumes when recovery on its repository context succeeds; abort feeds the conflict policy. |
| The conflict window opens automatically when a merge-like task moves to `waitingForInput` | `src/features/workflows/model/use-auto-open-conflicts.ts`, `ConflictWindow.tsx` | It works for any RepoId, so it also works for a temporary worktree once that worktree has a RepoId. |
| Push preflight records `expected_remote_oid` and pushes with a lease | `features/remotes/push.rs` (`RemotePushCommand`) | Target pushes use the same guard, so a target that moved on the remote is never overwritten. |
| Pull has strategies and a clean-worktree preflight | `features/remotes/pull.rs` (`PullStrategy`) | In-place mode uses fast-forward-only pull of the target. |
| Branch switch has a preflight | `features/branches/routes.rs` (`switch-preflight`, `switch`) | In-place mode reuses it for both switching away and returning. |
| Shelves can save and restore uncommitted work | `features/shelves/` | In-place mode auto-shelves a dirty worktree before switching. |
| A linked worktree is its own repository context with its own RepoId | `CONTEXT.md` | Worktree mode registers each temporary worktree as an ephemeral, hidden repository context. |
| Settings already combine an app-wide default with a "this repository" override | `src/features/remotes/ui/BackgroundFetchSettings.tsx` | The execution mode setting follows the same pattern. |
| Next migration number is `0019` | `crates/gitcrest-core/migrations/` | Rules, repository settings and runs go in `0019_pipelines.sql`. |

## 3. Concepts

| Term | Meaning |
| --- | --- |
| **Rule** | A per-repository definition: a trigger, an ordered list of targets and options. |
| **Trigger** | When a rule fires. v1: a push of a local branch succeeded and the branch name matches a glob (`feature/*`). |
| **Target** | An integration branch the source is merged into (`uat`, `dev`), with its own options. |
| **Run** | One execution of a rule for one source commit. Persisted, so it survives restarts. |
| **Step** | One target inside a run: prepare → merge → (conflicts) → push → done. |
| **Workspace** | Where a step does its Git work: a temporary linked worktree (default) or the user's own working tree (switch in place). |

## 4. Rule model

```jsonc
{
  "ruleId": "r_01",
  "name": "Promote feature to integration",
  "enabled": true,
  "trigger": { "kind": "afterPush", "branchPattern": "feature/*" },
  "targets": [
    { "branch": "uat", "remote": "origin" },
    { "branch": "dev", "remote": "origin" }
  ],
  "mergeMode": "noFastForward",             // noFastForward | fastForwardIfPossible
  "commitMessageTemplate": "Merge branch '{source}' into {target}",
  "pushAfterMerge": true,
  "onConflict": "openResolver",              // openResolver | skipTarget | stopRun
  "afterConflictResolved": "continue",       // continue | ask
  "confirmation": "ask"                      // ask | auto
}
```

Rules:

- `branchPattern` is a glob over the short local branch name. `*` does not cross `/`, `**` does.
- Targets run in list order, never in parallel. They share the source commit, not each other's results.
- The run merges the **commit that was pushed** (recorded at trigger time), not whatever the source branch points to later.
- Template placeholders: `{source}`, `{target}`, `{sourceShortOid}`. Unknown placeholders are a validation error.
- Validation rejects: a target equal to the source, a target that matches the rule's own `branchPattern`, duplicate targets, and an empty target list.
- Targets that look protected (`main`, `master`, `release/*`, `prod*`) force `confirmation: "ask"`. The editor shows why.

## 5. Execution modes

### 5.1 Setting

- **Settings → Automations → Execution mode** with two values: `Temporary worktree (recommended)` and `Switch in place`.
- There is an app-wide default (initially `Temporary worktree`) and a "This repository" override, following the background-fetch pattern.
- The mode is per repository, not per rule.
- A run records the mode it started with. Changing the setting never changes a run already in progress.

### 5.2 One engine, two workspaces

The run state machine is identical in both modes. Only the workspace is swapped behind an internal port:

```rust
#[async_trait]
pub(crate) trait PipelineWorkspace {
    /// Produce a tree with `target` checked out at the latest remote state.
    async fn prepare(&self, run: &PipelineRun, target: &PipelineTarget) -> Result<WorkspaceHandle, PipelineStepError>;
    /// RepoId whose conflict window and recovery routes serve this step.
    fn repo_context(&self, handle: &WorkspaceHandle) -> &str;
    /// Push the merged target with the remote-oid lease taken in `prepare`.
    async fn publish(&self, handle: &WorkspaceHandle) -> Result<(), PipelineStepError>;
    /// Release the step: remove the worktree, or return to the source branch.
    async fn finish(&self, handle: WorkspaceHandle, outcome: StepOutcome) -> Result<(), PipelineStepError>;
    /// Called once on startup for runs that were interrupted.
    async fn recover(&self, run: &PipelineRun) -> RecoveryProposal;
}
```

Tests drive the engine with a fake workspace. The two real workspaces get their own integration tests against real repositories.

### 5.3 Temporary worktree (default)

| Step | Behaviour |
| --- | --- |
| Preconditions | None on the user's working tree. Uncommitted changes and the current branch do not matter. |
| Prepare | `git fetch <remote> <target>`, record the fetched oid as the lease, then `git worktree add --detach <dir> <remote>/<target>`. `<dir>` lives under the app data directory (`pipelines/<runId>/<target>`), never inside the repository, so file watchers and IDEs do not see it. The worktree is registered as an **ephemeral repository context**: it has a RepoId and its own resource key, and it is hidden from the repository list and recent repositories. |
| Merge | The existing merge task runs against the ephemeral RepoId. |
| Conflicts | The conflict window opens on the ephemeral RepoId. Its title reads `uat · pipeline worktree` so it is clear this is not the user's tree. |
| Publish | `git push <remote> HEAD:<target> --force-with-lease=<target>:<lease oid>`. Afterwards, the local `<target>` branch, if it exists, is fast-forwarded only when that is possible; otherwise it is left alone and the run log says so. |
| Finish | `git worktree remove --force <dir>`, `git worktree prune`, then unregister the ephemeral context. The user never left the source branch. |
| Locks | Only the ephemeral context's lock is held. The main window stays fully usable while the run is in progress. |

A target branch that is already checked out in another worktree is not a problem, because the pipeline worktree is detached.

### 5.4 Switch in place

| Step | Behaviour |
| --- | --- |
| Preconditions | No Git operation in progress; otherwise the run does not start. A dirty working tree is auto-shelved (default) or refused, per the repository setting `inPlaceDirtyPolicy: shelve \| refuse`. |
| Prepare | Fetch, record the lease, then switch to `<target>` (created as a tracking branch from `<remote>/<target>` if missing) and fast-forward-only pull. If the local target has commits the remote does not have, the step fails with "local uat has unpushed commits". It never rebases or resets the user's branch. |
| Merge | The existing merge task on the main RepoId. |
| Conflicts | The existing conflict window on the main RepoId, exactly as for a manual merge. |
| Publish | A normal push of `<target>` with the same lease. |
| Finish | Always switch back to the source branch and restore the shelf, whatever the outcome (success, skip, abort or failure). A shelf restore that conflicts goes through the existing shelf-apply conflict flow. |
| Locks | The main repository's resource lock is held for the whole run and released only while waiting on conflicts. A banner reads "Pipeline running: branch operations paused", and branch, pull, push and stash actions are disabled with that reason. |

### 5.5 When worktree mode cannot run

If creating or using the temporary worktree fails (a path or permission problem, or an unsupported submodule or LFS setup), the run **does not fall back silently** to in-place mode, because that would touch the user's files without consent. The run stops with an error dialog offering **Run in place this time** and **Always use in place for this repository**.

## 6. Run engine

### 6.1 State machine

```
Run:   pendingConfirmation → running → (waitingForConflicts ↔ running) → succeeded | partiallySucceeded | failed | cancelled
Step:  pending → preparing → merging → waitingForConflicts → pushing → finishing → done | upToDate | skipped | failed
```

- `upToDate`: the merge relation is `MergeKind::UpToDate`, so there is nothing to merge or push. The step still counts as success.
- `partiallySucceeded`: at least one target done and at least one skipped or failed.
- A step that fails (prepare, merge, push or cleanup error, or a twice-rejected lease) stops the run: the remaining targets are marked `skipped` with the reason. A skipped conflict target does not stop it.
- Each step state change is persisted **before** the Git command it describes, so recovery knows what may have happened.

### 6.2 Tasks and locks

- A run is a parent record. Each step phase submits a normal task (`pipelineFetch`, `merge`, `push`, `pipelineCleanup`) with `repo_id` set to the workspace's RepoId, so it appears in the Task Center with its logs.
- The engine itself does not hold a worker permit while waiting. It reacts to task completion.
- Only one run per repository at a time. A second trigger while a run is active is queued as `pendingConfirmation`, and the user sees it in the Task Center.

### 6.3 Remote moved during a step

If the push lease is rejected because the target moved after the fetch, the step re-fetches, re-prepares and re-merges **once**. If it is rejected again, the step fails with "uat changed on the remote twice while merging; run again". Re-merging can produce new conflicts, which follow the normal conflict path.

### 6.4 Loop guard

- Pushes made by a run are tagged internally and never evaluated as triggers.
- Validation (§4) already rejects rules whose targets match their own pattern. Across rules, the engine also refuses to start a run whose source branch is a target of a run currently in progress.

## 7. Conflict integration

1. The merge task ends in `WaitingForInput` (existing behaviour). The engine moves the step and the run to `waitingForConflicts`.
2. `onConflict` decides what happens next:
   - `openResolver`: the conflict window opens automatically on the step's RepoId (existing `useAutoOpenConflicts`, extended to accept pipeline repository contexts).
   - `skipTarget`: the engine aborts the merge, marks the step `skipped` and goes on to the next target.
   - `stopRun`: the engine aborts the merge and finishes the run as `partiallySucceeded` or `failed`.
3. The recovery handler gets a hook: after continue or abort succeeds on a repository context owned by a run, it notifies the engine (`pipelines.on_workflow_recovered(repo_id, outcome)`).
   - Continue → the step moves to `pushing`. With `afterConflictResolved: "ask"`, the user confirms before the next target starts.
   - Abort → a dialog asks **Skip this target** or **Stop the pipeline**.
4. Closing the conflict window without resolving leaves the run waiting. The Task Center row offers **Resolve conflicts**, **Skip target** and **Stop**.

## 8. Crash and restart recovery

On startup, before triggers are evaluated, the engine loads runs that are not terminal and asks their workspace for a recovery proposal:

| Mode | Found state | Proposal |
| --- | --- | --- |
| Worktree | Worktree exists and has a merge in progress | Re-register the ephemeral context and offer **Resume conflicts**. |
| Worktree | Worktree exists, no merge in progress, merge commit not pushed | Offer **Resume (push)** or **Discard**. Pushing still uses the recorded lease, so a moved remote is caught. |
| Worktree | Worktree directory missing or orphaned | Prune it, mark the step `failed` and offer **Run again**. |
| In place | User is on a target branch, merge in progress | Offer **Resume conflicts** or **Abort and return to `<source>`**. |
| In place | User is on a target branch, no merge in progress | Offer **Return to `<source>` and restore shelf** or **Stay here**. |
| Either | Shelf recorded but not restored | Always surface it, even when the run itself is discarded. |

Orphan sweep: pipeline worktree directories under the app data directory with no matching run are removed, followed by `git worktree prune` in their parent repository.

## 9. Storage and API

### 9.1 Migration `0019_pipelines.sql`

- `pipeline_rules(repo_id, rule_id, position, definition_json, updated_at_ms)`
- `pipeline_repository_settings(repo_id, execution_mode NULL, in_place_dirty_policy NULL)`; `NULL` means "use the app default"
- `pipeline_app_settings(id = 1, execution_mode, in_place_dirty_policy)`: the app-wide defaults, read by the engine
- `pipeline_runs(run_id, repo_id, rule_snapshot_json, source_branch, source_oid, execution_mode, status, shelf_id NULL, created_at_ms, updated_at_ms)`
- `pipeline_steps(run_id, position, target_branch, remote, state, lease_oid NULL, merge_oid NULL, workspace_path NULL, ephemeral_repo_id NULL, message NULL)`

The app-wide default execution mode is stored with the other app settings.

### 9.2 Endpoints (all under `/v1`, all added to `doc/api/v1.yaml`)

| Method and path | Purpose |
| --- | --- |
| `GET/PUT /settings/pipelines` | App-wide default execution mode. |
| `GET/PUT /repositories/:repo_id/pipelines/settings` | Repository override for execution mode and dirty policy. |
| `GET/PUT /repositories/:repo_id/pipelines/rules` | List or replace the repository's rules (whole ordered list, validated as a unit). |
| `POST /repositories/:repo_id/pipelines/runs` | Start a run: confirm a pending trigger, or a manual run (`ruleId`, `sourceBranch`, `sourceOid`, optional subset of targets). |
| `GET /repositories/:repo_id/pipelines/runs` and `GET …/runs/:run_id` | Runs and their steps. |
| `POST …/runs/:run_id/actions` | `{ "action": "resume" \| "skipTarget" \| "stop" \| "returnToSource" \| "discard" }` |
| `POST /repositories/:repo_id/pipelines/rules/import` and `GET …/rules/export` | Exchange `.gitcrest/pipelines.json` (A4.3). |

Events (`doc/api/events-v1.md`): `pipeline.run.updated` (run and step states) and `pipeline.trigger.pending` (a rule with `confirmation: "ask"` fired).

### 9.3 Sharing rules through the repository

Rules can be exported to and imported from `.gitcrest/pipelines.json`. GitCrest **never applies rules from a repository file automatically**, because a cloned repository must not be able to make GitCrest push on the user's behalf. Import always shows the rules and requires confirmation, and imported rules start with `confirmation: "ask"`.

## 10. User interface

- **Settings → Automations** (new entry in `SETTINGS_SECTIONS`):
  - Execution mode: app default plus a "This repository" override, with a one-line explanation of each mode.
  - In-place dirty policy: shelve or refuse (visible only when the effective mode is in place).
  - Rule list for the open repository: add, edit, enable or disable, reorder, delete, import, export.
  - Rule editor: name, branch pattern with a live "matches: feature/1, feature/login" preview from local branches, targets (add from remote branches, drag to reorder), merge mode, message template with a rendered preview, conflict policy, confirmation.
- **Trigger confirmation** (`confirmation: "ask"`): a dialog listing targets with checkboxes, the execution mode, and **Run** / **Not now**, plus "Don't ask again for this rule" (not offered for protected targets).
- **Task Center**: a run is a grouped row such as `feature/1 → uat ✓ → dev ⚠ conflicts`, with steps expandable to their task logs and actions **Resolve conflicts**, **Skip target**, **Stop**, **Run again**.
- **In-place banner**: shown while an in-place run holds the repository (§5.4).
- **Branch context menu and command palette**: **Run pipeline…** picks a rule and runs it for that branch's pushed commit without pushing. It is disabled with a reason when the branch has no upstream or has unpushed commits.
- All strings are added in English and Chinese in `src/shared/i18n/messages/`. Disabled actions show a reason (`07`).

## 11. Safety rules

1. Nothing is pushed to a target without a lease taken from a fetch in the same step.
2. The user's working tree is never modified in worktree mode. In-place mode always returns to the source branch and restores the shelf, or tells the user exactly what is left to do.
3. No silent fallback between modes.
4. No rules are applied from repository files without confirmation.
5. Pipeline pushes never trigger pipelines.
6. Protected-looking targets always ask.
7. Logs go through the existing `redact_log_line`, and credentials go through the existing askpass flow. An authentication prompt during a pipeline push behaves exactly as it does for a manual push.

## 12. Decisions

| # | Question | Decision | Status |
| --- | --- | --- | --- |
| D1 | Execution model | Both. Temporary worktree is the default; switch in place is selectable in settings (app default and per-repository override). | decided 2026-10-31 |
| D2 | Dirty working tree in in-place mode | Auto-shelve by default; "refuse" selectable. | default adopted 2026-10-31 (A2.3) |
| D3 | After a conflict on one target is resolved | Continue to the next target automatically (`afterConflictResolved: "continue"`); "ask" selectable per rule. | default adopted 2026-10-31 (A3.2) |
| D4 | Default merge mode | `noFastForward`, so every promotion is visible as a merge commit. | default adopted 2026-10-31 (A1.1) |
| D5 | Merge commit message | Configurable per rule, default `Merge branch '{source}' into {target}`. | default adopted 2026-10-31 (A2.1) |
| D6 | Triggers in v1 | After push, plus manual **Run pipeline…**. Other triggers are out of scope. | default adopted 2026-10-31 (A3.1) |

## 13. Stages

Same rules as [13-implementation-plan.md](13-implementation-plan.md) §2 and [ux-functional-improvement-plan.md](ux-functional-improvement-plan.md) §1: one commit per stage, with code, tests and the status change in this file together, and an English commit message such as `feat: complete A2.2 run pipeline steps in a temporary worktree`. Every API stage updates `doc/api/v1.yaml`, runs `pnpm api:types` and adds contract tests (success, 400 validation, 401/403, 404, 409). Every stage passes `pnpm check`.

| ID | Stage | Size | Depends on | Pass rule | Status |
| --- | --- | --- | --- | --- | --- |
| A0.1 | Plan | S | — | This document reviewed; D2–D6 confirmed or changed. | done |
| A1.1 | Domain model and storage | M | A0.1 | `domain/pipeline.rs` (rule, target, run, step, states, validation), `0019_pipelines.sql`, storage port and SQLite adapter. Unit tests cover every validation rule in §4 and round-trip every table. | done |
| A1.2 | Settings and rules API | M | A1.1 | Endpoints for settings and rules (§9.2), effective-mode resolution (repository override → app default), contract tests. | done (409 does not apply: these endpoints have no conflicting state) |
| A2.1 | Run engine with a fake workspace | L | A1.1 | `PipelineWorkspace` port, state machine (§6.1), persistence before each step, remote-moved retry (§6.3), loop guard (§6.4), optional merge message added to `execute_workflow`. Engine tests with a fake workspace cover success, `upToDate`, skip, stop, lease rejection once and twice, and a queued second trigger. | done |
| A2.2 | Temporary worktree workspace | L | A2.1 | Worktree creation under the app data directory, ephemeral hidden repository context with its own resource key, lease push, local target fast-forward-only update, cleanup and orphan sweep. Integration tests against real repositories with a bare remote: two targets succeed, the user's dirty working tree and branch are unchanged afterwards, and no worktree is left behind. | done (steps run as plain Git processes here; Task Center tasks and credential environment are wired in A3.1) |
| A2.3 | Switch-in-place workspace | M | A2.1 | Preconditions, auto-shelve or refuse (D2), tracking-branch creation, fast-forward-only pull, divergence failure, guaranteed return to source and shelf restore on every outcome, repository lock held for the run. Integration tests cover each outcome and confirm the user ends on the source branch with their changes restored. | done (the shelf is a Git stash named gitcrest-pipeline-<runId>, restored with stash pop; branch operations are not locked by the backend, the in-place banner in A4.2 disables them) |
| A3.1 | Triggers and run API | M | A1.2, A2.2 | Evaluation after a successful push in core, `ask`/`auto`, `pipeline.trigger.pending` and `pipeline.run.updated` events, run endpoints and actions, manual run. Contract tests, plus a test that pipeline pushes do not trigger. | done |
| A3.2 | Conflict integration | M | A3.1, A2.3 | Conflict policies (§7), recovery hook, conflict window and auto-open for ephemeral contexts, abort dialog. E2E: a conflict on `uat` opens the window, resolving continues to `dev`, and both are pushed. | done (the E2E is covered by service-level tests that drive real repositories; no Electron window is automated) |
| A3.3 | Restart recovery | M | A3.2 | Startup proposals for every row in §8, orphan sweep. Tests kill the engine at each persisted step and check the proposal. | done (the engine is "killed" by building a second service over the same database and folders; leftover stashes of finished in-place runs are not surfaced yet) |
| A4.1 | Settings UI | M | A1.2 | Automations section, mode setting with override, rule list and editor with pattern and message previews, validation messages, i18n. Component tests for the editor. | done |
| A4.2 | Run UI | M | A3.2, A4.1 | Trigger confirmation dialog, grouped Task Center row with actions, in-place banner with disabled actions, **Run pipeline…** in the branch menu and command palette, worktree-failure dialog (§5.5). E2E for the main path in both modes. | done |
| A4.3 | Import and export | S | A4.1 | `.gitcrest/pipelines.json` schema, export, import with review and forced `ask`. Tests cover a malformed file and a protected target. | done |

Suggested order: A1.1 → A2.1 → A2.2 (default mode first) → A1.2 → A3.1 → A2.3 → A3.2 → A3.3 → A4.1 → A4.2 → A4.3.

## 14. Test matrix

Each scenario runs in both execution modes unless noted.

| Scenario | Expected result |
| --- | --- |
| Push `feature/1`, rule targets `uat`, `dev`, no conflicts | Both targets get a merge commit with the templated message and are pushed; the user is on `feature/1`. |
| `feature/1` already merged into `uat` | `uat` step is `upToDate`, nothing pushed; `dev` proceeds. |
| Conflict on `uat`, user resolves | Window opens, continue pushes `uat`, then `dev` runs. |
| Conflict on `uat`, user aborts and picks "Skip" | `uat` skipped, `dev` done, run `partiallySucceeded`. |
| Someone pushes to `uat` between fetch and push | One automatic retry; a second move fails the step without overwriting. |
| Dirty working tree (in place, shelve) | Changes shelved, run completes, changes restored on `feature/1`. |
| Dirty working tree (worktree) | Changes untouched throughout. |
| Local `uat` has unpushed commits (in place) | Step fails with the divergence message; the user is returned to `feature/1`. |
| App killed while waiting on conflicts | On restart, **Resume conflicts** is offered and works. |
| Worktree creation fails | Run stops; dialog offers in-place; nothing in the user's tree changed. |
| Rule targets `main` | Confirmation always asked; "don't ask again" not offered. |
| Imported `.gitcrest/pipelines.json` | Nothing runs until the user reviews and saves; imported rules ask. |

## 15. Out of scope and later ideas

- Other triggers (after commit, after PR merge, on schedule).
- Additional step kinds (run a command, create a tag, open a PR instead of pushing).
- Parallel targets.
- Automatic revert of a pushed integration merge.
