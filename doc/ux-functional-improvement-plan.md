# UX and Functional Completeness Improvement Plan

Status: proposed, nothing started. Date: 2026-10-31.
Scope: user-facing gaps in the desktop client (`src/`, `electron/`) and the core APIs they need (`crates/gitcrest-core/`, `doc/api/v1.yaml`). Release blockers already tracked in `13` (S6.x real-provider checks, S7.4, S7.5) are referenced, not repeated.
Related: [02-prd.md](02-prd.md) (requirements), [07-interaction-accessibility.md](07-interaction-accessibility.md) (keyboard and safety rules), [13-implementation-plan.md](13-implementation-plan.md) (ledger and commit rules), [electron-performance-optimization-plan.md](electron-performance-optimization-plan.md) (performance work).

This plan comes from a code and document review on 2026-10-31. The review read the PRD, the implementation ledger, the API contract and the renderer code; it did not run the app. The MVP main flows (stages 0–5) are in place and well guarded. What remains are the everyday operations that users of other Git clients expect, plus a few first-run problems. This document turns each gap into a small stage with a pass rule, so later revisions can pick them up one at a time.

---

## 1. How to use this plan

- Stage IDs are `U<workstream>.<n>`. Each stage is one commit, with the same rules as `13` §2: code, tests and the status change in this file land together, with an English commit message such as `feat: complete U2.1 checkout a commit from history`.
- Status values: **not started, in progress, awaiting acceptance, done, blocked, deferred** (same meaning as `13`).
- Every stage that touches the API updates `doc/api/v1.yaml`, runs `pnpm api:types`, and adds Rust contract tests for success, 401/403, 404 and conflict paths.
- Every stage that adds UI text adds both English and Chinese strings in `src/shared/i18n/messages/`, and gives disabled actions a visible reason (`07`).
- Every stage that adds a user action also adds a command-palette entry (see W5) and, where useful, a remappable shortcut in `src/features/settings/model/shortcut-preferences.ts`.
- Dangerous actions follow the existing pattern: preview endpoint → confirmation ticket → task, with a backup ref where recovery is possible (as in S5.5).
- A stage is done only after `pnpm check` passes; UI stages also need an E2E or component test for the main path.

Priority: **P0** blocks or confuses new users, **P1** completes common workflows, **P2** is polish. Size: **S** ≤ 1 day, **M** 2–4 days, **L** about a week.

## 2. Review corrections

Two concerns raised in the first review turned out to be already handled. They are recorded here so they are not reopened:

| Concern | Finding | Evidence |
|---|---|---|
| `Mod+Z`, `Mod+F`, `Mod+R` could take over text editing shortcuts | Global shortcuts skip `input`, `textarea`, `select` and `contenteditable` targets, except the two view switches | `src/app/use-global-shortcuts.ts:72` |
| The renderer bundle is not minified | `minify: "esbuild"` is now set | `electron.vite.config.ts:38` |

## 3. Summary of stages

| ID | Stage | Priority | Size | Depends on | Status |
|---|---|---|---|---|---|
| U1.1 | Git identity check and editor | P0 | M | — | not started |
| U1.2 | First-run hints and empty states | P2 | M | U1.1 | not started |
| U2.1 | Check out a commit (detached HEAD) | P0 | M | — | done |
| U2.2 | Reset to a commit from the history row | P0 | S | — | done |
| U2.3 | Copy and reuse a commit message | P0 | S | — | done |
| U3.1 | Tag list and tag labels on the graph | P0 | M | — | not started |
| U3.2 | Delete and push tags; push with tags | P0 | M | U3.1 | not started |
| U4.1 | Read existing `git stash` entries | P0 | M | D1 | not started |
| U4.2 | Apply, pop, drop or import a stash | P1 | M | U4.1 | not started |
| U5.1 | Complete command-palette coverage | P0 | M | — | not started |
| U5.2 | Palette search, grouping and recent commands | P2 | S | U5.1 | not started |
| U6.1 | Open in editor, terminal and browser | P1 | M | D3 | not started |
| U6.2 | Drop a folder to open a repository | P1 | S | — | not started |
| U7.1 | Background fetch | P1 | M | D2 | not started |
| U7.2 | System notifications for long tasks | P1 | S | — | not started |
| U8.1 | Compare two refs or a ref with the working tree | P1 | L | — | not started |
| U9.1 | Add to `.gitignore` from Changes | P1 | S | — | not started |
| U9.2 | Reflog view and lost-commit recovery | P1 | M | — | not started |
| U10.1 | Unified mode in the main Diff area | P1 | S | D4 | not started |
| U10.2 | Image diff | P2 | M | — | not started |
| U10.3 | Submodule status and update | P1 | L | — | not started |
| U10.4 | Recognize LFS pointer files | P2 | S | — | not started |
| U11.1 | Commit signing setup and failure help | P1 | M | U1.1 | not started |
| U12.1 | History search under 200 ms after a refs change | P1 | M | — | not started |
| U13.1 | Unified feedback with undo | P2 | M | — | not started |
| U13.2 | Interface zoom | P2 | S | — | not started |
| U14.1 | Split `App.tsx` into per-area controllers | P1 | L | — | not started |
| U14.2 | Repository hygiene | P2 | S | — | not started |

Release blockers from `13`, not repeated here: S6.1–S6.5 need one run each against real OpenAI Chat Completions, OpenAI Responses and Anthropic Messages; S7.4 (signing and updates on three platforms) and S7.5 (full P0 E2E and release notes) are blocked on outside environments.

## 4. Decisions needed before some stages

| ID | Question | Options | Recommendation |
|---|---|---|---|
| D1 | How do shelves and Git stash relate? | (a) Show stashes read-only beside shelves; (b) one list with a source label; (c) import stashes into shelves and leave Git stash alone | (b) one list labelled "Shelf" or "Git stash", with import as an action. Users then see everything they have parked in one place without GitCrest owning the stash format |
| D2 | Should background fetch be on by default? | (a) Off; (b) on, every 10 minutes, only for the active repository; (c) on for all open tabs | (b). It keeps ahead/behind current and never touches the working tree. It pauses on metered or offline networks and when the repository has a running task |
| D3 | How does the user pick an editor and terminal? | (a) System default only; (b) detect common editors and allow a custom command | (b), stored in Settings → General. The custom command is run by the main process with the path as a single argument, never through a shell string |
| D4 | Should the main Diff area allow Unified mode? | (a) Keep Split only (current PRD note); (b) allow both, remembered per user | (b). The PRD note reflects what was built, not a product rule. Staging controls must work in both modes |

## 5. Workstreams

### W1 — First run and identity

**U1.1 Git identity check and editor** (P0, M)
- Problem: nothing checks `user.name` / `user.email`. On a new machine the first commit fails with Git's raw "Please tell me who you are" output.
- Deliver: the repository response includes whether an author identity resolves, and from which scope (repository, global). The commit panel shows a blocking notice with a "Set identity" action when it does not. Settings → General gets an identity editor for the global scope; the repository scope is edited from the repository context menu. Values are written with `git config` by the core, never by the renderer.
- Accept: on a clean `HOME` with no identity, Commit is disabled with a reason before the user tries; setting the identity enables it without a restart. A repository-level identity overrides the global one, and the UI shows which one applies. Commit hook and signing errors still show their own output.
- Where: `crates/gitcrest-core/src/features/repositories/`, `crates/gitcrest-core/src/features/settings/`, `src/pages/workspace/CommitPanel.tsx`, `src/features/settings/ui/SettingsPage.tsx`.

**U1.2 First-run hints and empty states** (P2, M)
- Problem: the GitCrest-specific ideas (shelves instead of stash, structure-aware staging, the AI privacy preview, the safety previews) are not explained anywhere in the app.
- Deliver: short, dismissible inline hints shown once on first use of Changes, Shelves, the structure outline and the AI assistant; consistent empty states for no changes, no history, no remotes, no shelves and no tags, each with the next action. No modal tour.
- Accept: each hint shows once and can be reset from Settings; all empty states have an action button that works by keyboard; screen readers announce hints as notes, not alerts.

### W2 — History actions

The PRD (§7.5) promises checkout, cherry-pick, reset, tag and copy SHA on a commit. `src/features/history/ui/CommitActionsMenu.tsx` has copy SHA, branch, tag, merge, cherry-pick and revert.

**U2.1 Check out a commit (detached HEAD)** (P0, M)
- Deliver: "Check out this commit" in the commit menu, using the same dirty-tree preflight and options as branch switching (S4.2). After checkout the status bar and title show a clear detached-HEAD state with "Create branch here" and "Return to <previous branch>" actions.
- Accept: a clean tree checks out directly; a dirty tree shows commit / shelve / carry over / cancel and lists the files that would be overwritten; cancel leaves the tree unchanged; returning restores the previous branch.
- Where: `crates/gitcrest-core/src/features/branches/` (switch accepts a commit target), `src/features/branches/model/use-branch-switcher.ts`, `CommitActionsMenu.tsx`.

**U2.2 Reset to a commit from the history row** (P0, S)
- Deliver: "Reset current branch to here…" in the commit menu, opening the existing `ResetDialog` with the target filled in.
- Accept: the preview, confirmation ticket and backup ref behave exactly as in S5.5; the item is hidden for commits not reachable from HEAD, or disabled with a reason.

**U2.3 Copy and reuse a commit message** (P0, S)
- Deliver: in commit details, "Copy message" and "Use as new commit message". The second fills the commit draft and asks before replacing a non-empty draft.
- Accept: multi-line bodies are kept; the action is undoable with the draft's own undo; AI suggestion state is not affected.

### W3 — Tags

`/refs` leaves tags out to keep the first snapshot small, and the only tag API is `POST commits/{oid}/tags`.

**U3.1 Tag list and tag labels on the graph** (P0, M)
- Deliver: a paged `GET /repositories/{repoId}/tags` (name, target, annotated or not, tagger, date, message) with a filter; a Tags section in the sidebar; tag labels on graph rows for loaded commits only, fetched per page so large tag sets do not slow the first frame.
- Accept: a repository with 10,000 tags still meets the S7.2 first-frame target; selecting a tag selects its commit; annotated and lightweight tags are visibly different.

**U3.2 Delete and push tags; push with tags** (P0, M)
- Deliver: delete a local tag (with confirmation), delete a remote tag (preview + ticket, as for remote branch deletion), push one tag, and a "Push tags" option in the push dialog (`--follow-tags` by default, all tags on request).
- Accept: pushing a tag that already exists on the remote with a different target is refused with a clear message and no force by default; deleting a remote tag lists the remote and target before confirmation.
- Where: `crates/gitcrest-core/src/features/tags/`, `crates/gitcrest-core/src/features/remotes/push.rs`, `src/features/remotes/ui/PushDialog.tsx`.

### W4 — Git stash interoperability

The core has no stash code, so stashes made in the CLI or another IDE are invisible.

**U4.1 Read existing `git stash` entries** (P0, M; needs D1)
- Deliver: list stash entries with message, branch, date and changed files; show their diff read-only in the existing Diff views.
- Accept: entries match `git stash list`; untracked-file stashes (`-u`) show their untracked part; the list refreshes when `refs/stash` changes (S7.1 watcher).

**U4.2 Apply, pop, drop or import a stash** (P1, M)
- Deliver: apply and pop with the same preview and conflict path as shelves (S5.3 → S5.2); drop with confirmation; "Import as shelf", which keeps the stash unless the user chooses to drop it.
- Accept: a failed apply leaves the stash entry; conflicts open the conflict window; drop shows the stash's files before confirming.

### W5 — Command palette

**U5.1 Complete command-palette coverage** (P0, M)
- Problem: the palette (`src/app/App.tsx:867-886`) lacks merge, cherry-pick, revert, create/rename/delete branch, shelve, tags, settings, worktree actions, close tab, initialize repository, refresh and undo.
- Deliver: move the command list out of `App.tsx` into a registry (`src/app/commands/`) that each feature contributes to. Every action that has a shortcut in `shortcut-preferences.ts` must have a palette entry, and vice versa where it makes sense. A unit test enforces this.
- Accept: all P0 flows in `07` can be started from the palette; unavailable commands stay listed with their reason; the palette shows each command's current shortcut.

**U5.2 Palette search, grouping and recent commands** (P2, S)
- Deliver: fuzzy matching on label and synonyms (for example "stash" finds Shelve), groups by area, and the last five commands at the top.

### W6 — Working with other tools

**U6.1 Open in editor, terminal and browser** (P1, M; needs D3)
- Deliver: for a repository and for a file, "Open in editor" and "Open in terminal"; for a remote, "Open in browser" (https URLs derived from the remote, http(s) only, through the existing `openExternalHttpUrl` guard).
- Accept: paths are passed as arguments, never through a shell string; the renderer can only ask for paths inside an open repository; a missing editor shows a fix-it link to Settings.
- Where: `electron/main/index.ts`, `electron/preload/index.ts`, `src/api/bridge.ts`.

**U6.2 Drop a folder to open a repository** (P1, S)
- Deliver: dropping a folder on the welcome page or the tab bar opens it, using the existing open flow and its errors (not a repository, no permission, missing).
- Accept: dropping a file or several folders gives a clear message; the drop target has a visible state and a keyboard-free fallback is not needed because "Open" already exists.

### W7 — Background awareness

**U7.1 Background fetch** (P1, M; needs D2)
- Deliver: a scheduled fetch per D2, with the interval and on/off in Settings and per repository. It runs as a normal low-priority task, never blocks write tasks, and is skipped while a repository task runs.
- Accept: ahead/behind updates without user action; authentication failures are reported once, not every interval; the task log shows background fetches as such.

**U7.2 System notifications for long tasks** (P1, S)
- Deliver: when the window is not focused, push, pull, clone, fetch-with-new-commits and failed tasks raise a system notification; clicking it focuses the repository and opens the task.
- Accept: no notification while the window is focused; can be switched off in Settings; notification text contains no URL credentials.

### W8 — Compare

**U8.1 Compare two refs, or a ref with the working tree** (P1, L)
- Deliver: "Compare with…" on branches, tags and commits, and "Compare with working tree" on a commit. The result lists commits only on each side and the changed files, and opens file diffs in the existing read-only Diff window.
- Accept: results match `git log A..B`, `git log B..A` and `git diff A...B` (with a toggle for two-dot); large comparisons page and can be cancelled.

### W9 — File tools and recovery

**U9.1 Add to `.gitignore` from Changes** (P1, S)
- Deliver: on untracked files and folders, "Ignore file", "Ignore extension" and "Ignore folder", writing to the root `.gitignore` or `.git/info/exclude` as chosen, with a preview of the line.
- Accept: the change is a normal visible edit to `.gitignore`; the status refreshes and the file moves to the ignored group.

**U9.2 Reflog view and lost-commit recovery** (P1, M)
- Deliver: a read-only reflog for HEAD and each branch, with "Create branch here" and "Reset to here" (through the existing reset preview).
- Accept: entries match `git reflog`; recovery never runs without the reset preview and ticket; GitCrest's own backup refs (rebase, reset) appear alongside with their labels.

### W10 — Diff coverage

**U10.1 Unified mode in the main Diff area** (P1, S; needs D4)
- Deliver: the Split/Unified toggle (`Mod+\`) works in the main area, not only in the Diff window; hunk and line staging work in both modes.
- Accept: the selection model gives the same patch in both modes (test against `git diff --cached`); the choice is remembered.

**U10.2 Image diff** (P2, M)
- Deliver: side-by-side, swipe and onion-skin views for PNG, JPEG, GIF, WebP and SVG, with dimensions and size change.
- Accept: images load through the read-only diff API with a size cap; SVG is rendered as an image, never inlined as markup.

**U10.3 Submodule status and update** (P1, L)
- Problem: submodule paths show "not available yet" (`sd.submodule`).
- Deliver: show the old and new commit of a submodule change with a link to open the submodule as its own repository tab; "Init and update" and "Update" actions as tasks.
- Accept: nested repositories open with their own RepoId; update runs as a task with progress and can be cancelled.

**U10.4 Recognize LFS pointer files** (P2, S)
- Deliver: detect LFS pointers in diffs and status, label them, and show whether `git lfs` is installed. Full LFS management stays in v1.5 (`02` §8).
- Accept: a pointer diff shows "LFS object changed: <oid> <size>" instead of three lines of pointer text.

### W11 — Signing

**U11.1 Commit signing setup and failure help** (P1, M; after U1.1)
- Deliver: Settings shows the effective signing format (GPG, SSH, X.509), key and whether `commit.gpgsign` is on; a "Test signing" button; signing failures in the commit panel link to this section with the tool's own error output.
- Accept: no private key material passes through the app; a failed signature never creates a commit (as S2.5 already requires).

### W12 — Search speed

**U12.1 History search under 200 ms after a refs change** (P1, M)
- Problem: S7.2 records about 0.7 s for a full-result search after refs change, against the < 200 ms target. The cost is in the sidecar and Git.
- Deliver: keep the search index or the commit-graph cache valid across ref updates that only add commits, and rebuild only what changed.
- Accept: measured with the S7.2 scripts in `scripts/performance/`, 20 runs on the 100k fixture, P95 < 200 ms after a fetch that adds commits; evidence in `doc/evidence/U12.1/`.

### W13 — Feedback and comfort

**U13.1 Unified feedback with undo** (P2, M)
- Deliver: one notice queue replacing the per-feature notices, with success, warning and error kinds, and an Undo button where the action has a safe inverse (staging, branch delete via its backup, shelf delete).
- Accept: notices are announced through one `aria-live` region; they do not steal focus; errors stay until dismissed.

**U13.2 Interface zoom** (P2, S)
- Deliver: zoom in/out/reset (`Mod+=`, `Mod+-`, `Mod+0`) with the level in Settings → Appearance, next to the existing density setting.
- Accept: layout stays usable at 80–150%; the level is kept across restarts.

### W14 — Engineering health

**U14.1 Split `App.tsx` into per-area controllers** (P1, L)
- Problem: `src/app/App.tsx` is 1,315 lines and holds state for commits, branches, worktrees, remotes, workflows, settings and dialogs. Most stages above would grow it further.
- Deliver: move each area's state and dialog wiring into hooks or providers under its feature folder, leaving `App.tsx` to compose them. No behavior changes.
- Accept: `pnpm check` and all E2E pass unchanged; `App.tsx` under 400 lines; `pnpm frontend:boundaries` still passes. Do this before W5's registry if both are planned in the same period.

**U14.2 Repository hygiene** (P2, S)
- Deliver: ignore or delete the local build folders `dist-nosb/`, `dist-nosb2/` and `dist-p15/`, and add a `dist-*/` rule to `.gitignore`.

## 6. Suggested order

1. **New-user blockers:** U1.1, U2.3, U2.2, U2.1.
2. **Release workflow:** U3.1, U3.2.
3. **Structure before growth:** U14.1, then U5.1 (the registry is easier after the split).
4. **Interop and awareness:** D1 → U4.1, U4.2; D2 → U7.1, U7.2.
5. **Daily comfort:** D3 → U6.1, U6.2, U9.1, D4 → U10.1.
6. **Depth:** U8.1, U9.2, U11.1, U12.1, U10.3.
7. **Polish:** U1.2, U5.2, U10.2, U10.4, U13.1, U13.2, U14.2.

Run the S6 real-provider checks whenever API keys are available; they do not depend on anything here.

## 7. Closing checklist for this plan

- [ ] Every P0 stage is done, with evidence recorded below.
- [ ] D1–D4 are decided and recorded in §4 with a date.
- [ ] `02-prd.md` §7 notes are updated where a stage changes a stated limit (for example D4).
- [ ] `release-notes-alpha-draft.md` lists what this plan added and what remains.
- [ ] The palette coverage test from U5.1 passes for all actions added by later stages.

## 8. Progress log

Add one entry per finished or blocked stage, in this format:

```
### Ux.y — <title>
- Status:
- Tests: <commands and results>
- Manual check: <environment and scenario, or "not run" with reason>
- Evidence: <paths>
- Limits / follow-up:
- Commit: <SHA>
```

### U2.3 — Copy and reuse a commit message
- Status: done
- Tests: `tsc --noEmit` (app and test configs), `pnpm frontend:boundaries`, `vitest run` (79 files, 446 tests, including `tests/unit/commit-details-message.test.tsx`). Rust, clippy and E2E not run: no core or API change.
- Manual check: not run (app not started in this session).
- Evidence: `tests/unit/commit-details-message.test.tsx`
- Limits / follow-up: "Copy message" and "Use as new commit message" live in the commit inspector (`CommitDetails`). Command-palette entries come with U5.1. The draft is filled through `setCommitMessage`, so the AI suggestion state is untouched; undo relies on the draft field's own undo.
- Commit: see git log (`feat: complete U2.3 copy and reuse a commit message`)

### U2.2 — Reset to a commit from the history row
- Status: done
- Tests: `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (447 tests, new case in `tests/unit/reset-dialog.test.tsx`), `pnpm test:e2e` (38 tests). Rust not run: no core change.
- Manual check: not run.
- Evidence: `tests/unit/reset-dialog.test.tsx`
- Limits / follow-up: the commit menu gains "Reset current branch to here…", which opens `ResetDialog` with the commit preselected; preview, ticket and backup ref are unchanged. The item is disabled with a reason when the commit is already the current branch tip. Reachability from HEAD is not checked in the UI; the core preview decides. Palette entry comes with U5.1.
- Commit: see git log (`feat: complete U2.2 reset to a commit from the history row`)

### U2.1 — Check out a commit (detached HEAD)
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (202 tests, new `commit_checkout_detaches_head_and_rejects_bad_targets` covers 401, 403, 400, 404, 409 and success), `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (449 tests, new `tests/unit/branch-switcher-commit.test.tsx`), `pnpm test:e2e` (38 tests).
- Manual check: not run (app not started in this session).
- Evidence: `crates/gitcrest-core/src/tests.rs`, `tests/unit/branch-switcher-commit.test.tsx`
- Limits / follow-up: the switch endpoints take `commit: true` (`name` is a commit id) and run `git switch --detach` under the same overlap rules as a branch switch; the preflight response gains `detached`. The existing switcher dialog handles the dirty tree (commit / shelve / carry over / cancel), and the shelf flow carries the commit flag. The detached banner gains "Return to <branch>", remembered when the checkout is reviewed (kept in memory, lost on restart); "Create branch here" already existed. The History commit menu has "Check out this commit…". Palette entry comes with U5.1.
- Commit: see git log (`feat: complete U2.1 check out a commit with a detached HEAD`)
