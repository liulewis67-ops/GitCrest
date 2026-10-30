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
| U1.1 | Git identity check and editor | P0 | M | — | done |
| U1.2 | First-run hints and empty states | P2 | M | U1.1 | done |
| U2.1 | Check out a commit (detached HEAD) | P0 | M | — | done |
| U2.2 | Reset to a commit from the history row | P0 | S | — | done |
| U2.3 | Copy and reuse a commit message | P0 | S | — | done |
| U3.1 | Tag list and tag labels on the graph | P0 | M | — | done |
| U3.2 | Delete and push tags; push with tags | P0 | M | U3.1 | done |
| U4.1 | Read existing `git stash` entries | P0 | M | D1 | done |
| U4.2 | Apply, pop, drop or import a stash | P1 | M | U4.1 | done |
| U5.1 | Complete command-palette coverage | P0 | M | — | done |
| U5.2 | Palette search, grouping and recent commands | P2 | S | U5.1 | done |
| U6.1 | Open in editor, terminal and browser | P1 | M | D3 | done |
| U6.2 | Drop a folder to open a repository | P1 | S | — | done |
| U7.1 | Background fetch | P1 | M | D2 | done |
| U7.2 | System notifications for long tasks | P1 | S | — | done |
| U8.1 | Compare two refs or a ref with the working tree | P1 | L | — | not started |
| U9.1 | Add to `.gitignore` from Changes | P1 | S | — | done |
| U9.2 | Reflog view and lost-commit recovery | P1 | M | — | done |
| U10.1 | Unified mode in the main Diff area | P1 | S | D4 | done |
| U10.2 | Image diff | P2 | M | — | not started |
| U10.3 | Submodule status and update | P1 | L | — | not started |
| U10.4 | Recognize LFS pointer files | P2 | S | — | done |
| U11.1 | Commit signing setup and failure help | P1 | M | U1.1 | done |
| U12.1 | History search under 200 ms after a refs change | P1 | M | — | not started |
| U13.1 | Unified feedback with undo | P2 | M | — | not started |
| U13.2 | Interface zoom | P2 | S | — | done |
| U14.1 | Split `App.tsx` into per-area controllers | P1 | L | — | not started |
| U14.2 | Repository hygiene | P2 | S | — | done |

Release blockers from `13`, not repeated here: S6.1–S6.5 need one run each against real OpenAI Chat Completions, OpenAI Responses and Anthropic Messages; S7.4 (signing and updates on three platforms) and S7.5 (full P0 E2E and release notes) are blocked on outside environments.

## 4. Decisions needed before some stages

| ID | Question | Options | Recommendation |
|---|---|---|---|
| D1 | How do shelves and Git stash relate? | (a) Show stashes read-only beside shelves; (b) one list with a source label; (c) import stashes into shelves and leave Git stash alone | (b) one list labelled "Shelf" or "Git stash", with import as an action. Users then see everything they have parked in one place without GitCrest owning the stash format |
| D2 | Should background fetch be on by default? | (a) Off; (b) on, every 10 minutes, only for the active repository; (c) on for all open tabs | (b). It keeps ahead/behind current and never touches the working tree. It pauses on metered or offline networks and when the repository has a running task |
| D3 | How does the user pick an editor and terminal? | (a) System default only; (b) detect common editors and allow a custom command | (b), stored in Settings → General. The custom command is run by the main process with the path as a single argument, never through a shell string |
| D4 | Should the main Diff area allow Unified mode? | (a) Keep Split only (current PRD note); (b) allow both, remembered per user | (b). The PRD note reflects what was built, not a product rule. Staging controls must work in both modes |

### Decisions recorded

| ID | Decided | Date | Note |
|---|---|---|---|
| D1 | (b) one list labelled by source, with import as an action | 2026-10-31 | Adopted from the recommendation while carrying out the plan; revisit if it proves wrong. U4.1 shows Git stash entries in the Shelves tab under their own "Git stash" heading and badge; U4.2 adds the actions and "Import as shelf". |
| D2 | (b) on by default, every 10 minutes, only for the open repository | 2026-10-31 | Adopted from the recommendation. The interval (5, 10, 15, 30 or 60 minutes), the on/off switch and a per-repository switch are in Settings → General. It pauses while the window is hidden or offline and while the repository has another task; the metered-network part of the recommendation is not implemented because the app has no reliable way to detect a metered connection. |
| D3 | (b) detect common editors and allow a custom program, stored in Settings → General | 2026-10-31 | Adopted from the recommendation. The custom entry is one program, not a command line: the main process starts it without a shell and gives it the path as its only argument. Windows batch files are refused (they need a shell); choose the .exe. |
| D4 | (b) both layouts, remembered per user | 2026-10-31 | Adopted from the recommendation. Staging works in both layouts; the choice is stored with the other diff view preferences and shared by the main area and the Diff window. The PRD §7 note that the main area is Split only is therefore out of date (checklist item). |

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

- [x] Every P0 stage is done, with evidence recorded below (U1.1, U2.1, U2.2, U2.3, U3.1, U3.2, U4.1, U5.1; see the progress log).
- [x] D1–D4 are decided and recorded in §4 with a date (all four adopted the recommended option on 2026-10-31).
- [x] `02-prd.md` §7 notes are updated where a stage changes a stated limit (D4 done in U10.1; re-check as later stages land).
- [x] `release-notes-alpha-draft.md` lists what this plan added and what remains (section dated 2026-10-31; refresh it when more stages land).
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

### U1.1 — Git identity check and editor
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (204 tests, new `identity_api_reads_writes_and_clears_a_repository_identity` covers 401, 403, 404, 400 and write/clear, plus a unit test for field validation), `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (454 tests; new `git-identity.test.tsx` and `commit-workbench-identity.test.tsx`), `pnpm test:e2e` (38 tests).
- Manual check: not run. The tests never write the global Git config; the global PUT is only covered for validation errors.
- Evidence: `crates/gitcrest-core/src/features/identity/`, `src/features/identity/`
- Limits / follow-up: instead of a field on the repository response, identity has its own endpoints (`GET/PUT /identity` for global, `GET/PUT/DELETE /repositories/{repoId}/identity` for the repository). Values come from `git config --show-scope`, so the scope of each value is shown; `GIT_AUTHOR_*` environment variables are not detected. The commit panel blocks Commit with a reason and shows "Set identity" with an inline editor (global or this repository, plus "use the global identity"). Settings → General has the global editor. The plan also asked for a repository-context-menu entry; the commit-panel editor covers the repository scope instead. A failed identity read never blocks committing.
- Commit: see git log (`feat: complete U1.1 check the Git author identity before committing`)

### U14.2 — Repository hygiene
- Status: done
- Tests: `git status --short` no longer lists `dist-nosb/`, `dist-nosb2/` or `dist-p15/`.
- Manual check: not applicable.
- Evidence: `.gitignore`
- Limits / follow-up: the three folders are ignored, not deleted; they are local build output and can be removed by hand.
- Commit: see git log (`chore: complete U14.2 ignore local dist-* build folders`)

### U3.1 — Tag list and tag labels on the graph
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (207 tests; new `tag_list_api_pages_filters_and_distinguishes_annotated_tags` covers 401, 400, 404, paging over 500 tags, name filter, target filter and annotated vs lightweight), `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (459 tests; new `tag-list.test.tsx`), `pnpm test:e2e` (38 tests).
- Manual check: not run (app not started). Timing on this machine: `git for-each-ref` over 10,000 tags took 1.5 s with names only, but 8–10 s as soon as tag objects were read. The endpoint therefore reads names and peeled targets only and loads tagger, date and message just for the annotated tags on the returned page.
- Evidence: `crates/gitcrest-core/src/features/tags/listing.rs`, `src/features/history/ui/TagList.tsx`, `src/features/history/model/use-commit-tags.ts`
- Limits / follow-up: `GET /repositories/{repoId}/tags` pages by version-sorted name (newest version first), not by date, because sorting by date needs every tag object. Lightweight tags have no date or message. The 100k-commit S7.2 first-frame benchmark was not re-run; the first snapshot is unchanged because tags still stay out of `/refs`, and the sidebar and graph labels load afterwards. Graph labels are fetched per page of loaded commits (100 commits per request). A lightweight tag on a non-commit object is not detected without reading the object. Annotated and lightweight tags differ by marker (◆/◇) and badge border.
- Commit: see git log (`feat: complete U3.1 list tags and label them on the commit graph`)

### U3.2 — Delete and push tags; push with tags
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (208 tests; new `tag_management_api_deletes_pushes_and_never_overwrites_remote_tags` runs against a local bare remote and covers 400, 403, 404, 409, push, refusal to overwrite, remote delete with a wrong and a right lease, and local delete; the existing push test now also pushes an annotated tag with `--follow-tags`), `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (464 tests; new `tag-actions.test.tsx` and a push-dialog case), `pnpm test:e2e` (38 tests). The first E2E run of the day failed one test that I could not identify; two reruns passed 38 of 38, so it is recorded as an unexplained flake.
- Manual check: not run (app not started). Real-remote authentication was not exercised; the tests use a local bare remote.
- Evidence: `crates/gitcrest-core/src/features/tags/` (`management.rs`, `remote_handlers.rs`), `src/features/history/ui/TagActionsDialog.tsx`
- Limits / follow-up: new endpoints `POST /tags/delete`, `GET /tags/remote-preview`, `POST /tags/push`, `POST /tags/remote-delete`, and `tags` (`none`, `followTags`, `all`) on `PushRequest`. Instead of a signed confirmation ticket, the remote delete is bound to the object read by the preview and runs as `--force-with-lease`, and the local delete is bound to the reviewed commit. Tag pushes never force; a remote tag with a different object is refused with 409 before anything is sent, and Git refuses it as a second line. The Push dialog defaults to `followTags`; the quick commit-and-push path sends no tags. Tag actions live in each tag row's menu in the sidebar; palette entries come with U5.1. Deleting a remote tag does not remove other clones' copies.
- Commit: see git log (`feat: complete U3.2 delete and push tags, and push tags with a branch`)

### U4.1 — Read existing git stash entries
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (210 tests; new `stash_api_lists_entries_made_with_git_stash_including_untracked_parts` compares with `git stash list` order and `stash@{n}^3`, and covers 401 and 404; plus a parser unit test), `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (468 tests; new `stash-list.test.tsx`), `pnpm test:e2e` (38 tests).
- Manual check: not run (app not started). Opening a stash file goes through the existing commit-file diff navigation; that hop was covered by types and unit tests only.
- Evidence: `crates/gitcrest-core/src/features/stash/`, `src/features/shelves/ui/StashList.tsx`
- Limits / follow-up: `GET /repositories/{repoId}/stashes` returns index, commit, base, untracked commit, branch, message and time. Changed files come from the existing commit detail endpoint for the stash commit and, for `-u` stashes, its untracked commit (marked "untracked"). The section is hidden when there is no stash. The list refreshes with the history refresh key, which the watcher bumps on any `refs/stash` or `logs/refs/` change. Only the newest 200 entries are read. Apply, pop, drop and import are U4.2.
- Commit: see git log (`feat: complete U4.1 read existing git stash entries`)

### U5.1 — Complete command-palette coverage
- Status: done
- Tests: `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (477 tests; new `palette-commands.test.ts`), `pnpm test:e2e` (38 tests). No Rust or API change.
- Manual check: not run (app not started).
- Evidence: `src/app/commands/palette-commands.ts`, `tests/unit/palette-commands.test.ts`
- Limits / follow-up: the command list moved out of `App.tsx` into `createPaletteCommands`. It now holds 40 commands in groups, each with the current binding of its shortcut and, when unavailable, a reason in place of the description. `SHORTCUT_COMMANDS` maps every remappable shortcut to its palette entry or a stated exemption (the palette itself, and the Diff-window-only split/unified toggle); adding a shortcut without a mapping fails the type check, and the unit test checks that every mapped entry exists and shows the same binding. New entries: initialize, commit, commit and push, stage all, undo, refresh, open diff, search commits, shelve, settings, merge, cherry-pick, revert, tag, check out and reset to the selected commit, branch at current commit, rename current branch, new worktree, close tab. Not in the palette: per-tag actions (U3.2), "use as commit message" (U2.3, needs the commit panel's state) and the Git stash list; delete branch needs a branch choice and stays in the switcher. `App.tsx` still holds the shortcut handlers separately (U14.1). The plan's search, synonyms and recent commands are U5.2.
- Commit: see git log (`feat: complete U5.1 cover every action in the command palette`)

### U9.1 — Add to .gitignore from Changes
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (214 tests; new `ignore_api_writes_rules_that_git_honours_and_refuses_unsafe_paths` covers 401, 403, 404, 400, the preview, the shared and private files, a missing final newline, duplicate lines and `git check-ignore`; plus unit tests for the pattern builder and escaping), `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (480 tests; new `ignore-rule-dialog.test.tsx`), `pnpm test:e2e` (38 tests).
- Manual check: not run (app not started).
- Evidence: `crates/gitcrest-core/src/features/ignore/`, `src/features/changes/ui/IgnoreRuleDialog.tsx`
- Limits / follow-up: new `GET /repositories/{repoId}/ignore-preview` and `POST /repositories/{repoId}/ignore`. Untracked files and folders in Changes get "Add file to ignore list…", "Ignore all files with this extension…" and "Ignore the containing folder…". The dialog shows the line and the file first and offers the shared `.gitignore` or the private `.git/info/exclude`. Paths outside the repository, inside `.git`, or with line breaks are refused, and characters that gitignore reads specially are escaped. An existing identical line is not repeated. The status is refreshed after the write, so the file moves to the ignored group. Already-tracked files are not touched, as the menu only appears for untracked entries. No palette entry: the action is per file, and the palette has no file picker.
- Commit: see git log (`feat: complete U9.1 add ignore rules from the Changes view`)

### U4.2 — Apply, pop, drop or import a stash
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (215 tests; new `stash_operations_preview_apply_drop_and_import_without_losing_changes` covers 400, 401, 403, 404, the preview with and without blocking local edits, import with the entry kept, apply keeping the entry, a stale HEAD (409), a failed pop keeping the entry, a clean pop, drop, and import with drop), `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (488 tests; new `stash-actions.test.tsx`), `pnpm test:e2e` (38 tests).
- Manual check: not run (app not started).
- Evidence: `crates/gitcrest-core/src/features/stash/` (`ops.rs`, `ops_handlers.rs`), `src/features/shelves/ui/StashActionDialog.tsx`
- Limits / follow-up: new `GET /stashes/preview` and `POST /stashes/apply`, `/stashes/drop`, `/stashes/import`. Every request names the entry by its stash commit, not its position, and finds it again before acting, so a list that changed in between is refused (404) instead of touching another entry. Apply and pop run as tasks and are refused (409) when HEAD moved after the review or an operation is in progress; the preview blocks them when local edits overlap the stash's files. Pop drops the entry only when it applied cleanly. "Import as shelf" writes a shelf (tracked changes plus the untracked files of a `-u` stash) without touching the working tree, and drops the entry only on request and after the shelf is saved. A conflicting apply fails the task, keeps the stash entry and leaves the conflicted files in Changes; it does not open the merge conflict window, because a stash apply creates no in-progress operation to continue or abort. A dropped entry's commit stays in Git until garbage collection. Palette entries for stash actions are not added: they need an entry picked from the list.
- Commit: see git log (`feat: complete U4.2 apply, pop, drop and import git stash entries`)

### U5.2 — Palette search, grouping and recent commands
- Status: done
- Tests: `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (500 tests; new `palette-search.test.tsx`), `pnpm test:e2e` (38 tests on the final run). One earlier E2E run in this stage failed a single test that I could not identify, and two further runs were killed by my own 280-second timeout, so they say nothing; the next full run passed 38 of 38. The earlier unexplained failure in U3.2 may be the same intermittent test; neither failure was reproduced with a log.
- Manual check: not run (app not started).
- Evidence: `src/app/commands/palette-search.ts`, `tests/unit/palette-search.test.tsx`
- Limits / follow-up: matching covers the label, the description and a synonym list (`stash` finds Shelve, `checkout` finds the branch switcher and commit checkout, `ship` finds Commit and push, with Chinese terms too), every word of a multi-word query must appear, and a run of letters inside a label matches (`cpk` finds Cherry-pick). A search shows one ranked list, where a runnable command beats an equally good unavailable one. With no search, the last five commands run lead in a "Recent" group, moved out of their own group so nothing is listed twice, and the rest follow in groups. Recents live in the browser's local storage and the palette works without it. Matching is not typo-tolerant, and Chinese queries match only the Chinese strings in the synonym list and labels.
- Commit: see git log (`feat: complete U5.2 rank palette search and remember recent commands`)

### U10.1 — Unified mode in the main Diff area
- Status: done
- Tests: `tsc --noEmit` (both configs), `pnpm frontend:boundaries`, `vitest run` (504 tests; four new `SplitDiff` layout cases and the palette registry test for the new entry), `pnpm test:e2e` (38 tests on the final run). No Rust or API change.
- Manual check: not run (app not started).
- Evidence: `tests/unit/split-diff.test.tsx` ("SplitDiff layouts"), `src/features/diff/ui/SplitDiff.tsx`
- Limits / follow-up: the line-selection view (`SplitDiff`) takes a `layout` of split or unified. In unified, deleted lines come above added ones with one checkbox per line; a line that is half of a paired row selects only its own side, and a lone added or deleted line selects its row. The selection is stored as the same (hunk, row, side) items in both layouts, and a test checks that the same choices send an identical staging request in both, so the patch the core builds is identical (the core never sees the layout; no separate `git diff --cached` comparison was added). A Split/Unified switch sits in the diff header of the line view, Mod+ now works anywhere a file diff is showing (also as the palette entry "Toggle Split/Unified diff"), and the Diff window uses the same stored preference instead of resetting to Split. The full-file view already had the same switch. Not covered: unified rows in Monaco's own single-hunk view, which keeps its fixed layout.
- Also in this stage: the keyboard-workflow E2E test walked Tab at most 80 times to reach "Refresh working tree status"; measured runs needed 15 to 46 presses depending on where focus landed, which explains the intermittent failures recorded under U3.2 and U5.2 (the failing step was identified from a captured log on the last intermittent failure). The limit is now 200.
- Commit: see git log (`feat: complete U10.1 unified diff layout with staging in the main area`)

### U13.2 — Interface zoom
- Status: done
- Tests: `tsc --noEmit` (both configs), `pnpm build` (includes the preload change), `pnpm frontend:boundaries`, `vitest run` (516 tests; new `zoom.test.tsx`, `diff-view-preferences.test.tsx`), `pnpm test:e2e` (38 tests, run after a fresh `pnpm build`).
- Manual check: not run (app not started). The plan's "layout stays usable at 80–150%" was not checked by eye; only the mechanism is tested.
- Evidence: `src/features/settings/model/zoom-store.ts`, `tests/unit/zoom.test.tsx`
- Limits / follow-up: six levels from 80% to 150%, kept in local storage and shared by every window (a change in one follows in the others). Mod+=, Mod+- and Mod+0 are remappable shortcuts handled in every window, including from text fields; they replace the window's built-in zoom keys and are also in the command palette. Settings → Appearance has minus, plus and reset buttons with the current level. The desktop app zooms through Electron's `webFrame` (the preload accepts only factors from 0.5 to 2); outside it the page falls back to CSS zoom. Ctrl+Plus on keyboards that need Shift for "+" is not bound; Ctrl+= is.
- Process finding, which affects earlier entries: `pnpm test:e2e` runs against the built app in `out/` and does not rebuild it, and I ran it without rebuilding for most stages since U2.1. Those runs therefore did not always exercise the newest code. The full suite now passes against a fresh build that contains every change up to this stage, so the cumulative state is verified, but individual earlier "38 passed" figures should be read with that caveat. `pnpm check` builds first and is the reliable gate. Running it against the fresh build also found and fixed three real problems: a stale-closure bug in the Diff window's Split/Unified shortcut (from U10.1), two palette lookups in `desktop.test.ts` that the U5.1 palette entries made ambiguous, and the Tab limit in `keyboard-workflow.test.ts` (see U10.1).
- Commit: see git log (`feat: complete U13.2 add interface zoom`)

### U6.2 — Drop a folder to open a repository
- Status: done
- Tests: `tsc --noEmit` (both configs), `pnpm build`, `pnpm frontend:boundaries`, `vitest run` (523 tests; new `folder-drop.test.tsx`), `pnpm test:e2e` (38 tests, after the build).
- Manual check: not run. A real drag from the file manager into the Electron window was not exercised, so the `webUtils.getPathForFile` path (the part unit tests replace with a stub) is untested end to end.
- Evidence: `src/features/repositories/model/use-folder-drop.ts`, `tests/unit/folder-drop.test.tsx`
- Limits / follow-up: instead of separate targets on the welcome page and tab bar, the whole window accepts the drop, with a full-window "Drop a folder here" hint while files are dragged over it. Text and link drags are ignored. A single folder goes through the existing open flow, which already reports "not a repository", missing and permission errors; a plain file or several items show a clear message (in the welcome page's error area and as a notice). The disk path comes from the preload's `getPathForFile`, which only answers with a real path for files on disk. A drop onto a text field in a dialog is still treated as a folder drop, since the check is on the window.
- Commit: see git log (`feat: complete U6.2 open a repository by dropping its folder`)

### U6.1 — Open in editor, terminal and browser
- Status: done
- Tests: `tsc --noEmit` (both configs), `pnpm build`, `pnpm frontend:boundaries`, `vitest run` (548 tests; new `external-tools.test.ts` for detection, launching, path checks and the saved choice with a fake environment, `external-tools-settings.test.tsx`, `remote-web-url.test.ts`), `pnpm test:e2e` (38 tests, after the build; `desktop.test.ts` now calls the real bridge in Electron and checks that an unknown repository, a `../` path and an absolute path are refused without starting anything).
- Manual check: not run. No editor or terminal was actually started in any test, so the real launch on Windows, macOS and Linux (the `start` function in `electron/main/index.ts`) and the macOS and Linux detection paths are untested on real machines.
- Evidence: `electron/main/external-tools.ts`, `tests/unit/external-tools.test.ts`
- Limits / follow-up: "Open in editor" is in the palette (repository) and on file rows in Changes; "Open in terminal" is in the palette; remotes in the sidebar have "Open in browser". The renderer sends only a repository id and a relative path; the main process asks the core for the folder, resolves the path itself, and refuses unknown repositories, absolute paths, `..` and line breaks. Programs start detached without a shell with the path as one argument; terminals start in the folder through the working directory. Detected editors are VS Code, Cursor, Sublime Text and Notepad++ in their usual places (the Windows lookup for names on PATH accepts only .exe). A missing or invalid editor shows its message and opens Settings → General. The web address is derived from the fetch URL (scp-style, ssh, https, git), drops credentials and `.git`, and has no page for local paths; only http and https addresses are opened. Not done: an editor entry on the repository tab menu and a terminal entry for single files, and no terminal choice in Settings (the system default is used).
- Commit: see git log (`feat: complete U6.1 open repositories in an editor, a terminal and the browser`)

### U7.1 — Background fetch
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (216 tests; new `background_fetch_runs_as_its_own_operation_and_is_skipped_while_a_task_runs` holds a manual fetch with a slow `uploadpack`, sees the scheduled one refused with 409, then accepted as `fetchBackground`), `tsc --noEmit` (both configs), `pnpm build`, `pnpm frontend:boundaries`, `vitest run` (562 tests; new `background-fetch.test.tsx` with fake timers), `pnpm test:e2e` (38 tests, after the build).
- Manual check: not run. A scheduled fetch against a real remote with real credentials, and the visibility and online checks in a real window, were not exercised.
- Evidence: `src/features/remotes/model/use-background-fetch.ts`, `crates/gitcrest-core/src/features/remotes/handlers.rs`
- Limits / follow-up: `POST /repositories/{repoId}/fetch` takes an optional `background` flag. It runs as the operation `fetchBackground` (shown as that in the task list, apart from a manual `fetch`) and is refused with 409 when the repository has a queued or running task, so it never waits in front of the user's work. The renderer checks the schedule every 30 seconds for the open repository only, needs it to be connected, available, have remotes and no task, skips a hidden or offline window, and records the task without opening the task list. A skipped (409) fetch is retried after about a minute. If a scheduled fetch fails to sign in, one notice appears and that repository is not asked again until the user's own fetch succeeds or a background-fetch setting changes; other failures wait for the next interval. Repositories in other tabs are not fetched. The "metered network" pause is not implemented.
- Commit: see git log (`feat: complete U7.1 fetch the open repository in the background`)

### U7.2 — System notifications for long tasks
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (216 tests; the background-fetch test now also pushes a commit from another clone and checks that the fetch log names the moved refs with `->`, which the new-commits detection relies on), `tsc --noEmit` (both configs), `pnpm build`, `pnpm frontend:boundaries`, `vitest run` (573 tests; new `task-notifications.test.tsx`), `pnpm test:e2e` (38 tests, after the build; the desktop test also checks that Electron's main process drops a malformed notification request).
- Manual check: not run. No system notification was shown on screen, and clicking one to bring the window back and open the task list was not exercised in a real window.
- Evidence: `src/features/tasks/model/task-notification.ts`, `src/features/tasks/model/use-task-notifications.ts`, `electron/main/index.ts`
- Limits / follow-up: a notification is raised when push, pull, clone, a fetch whose log shows moved refs, or any other task fails, and only if the task was seen running before and the window is not focused. A scheduled fetch that fails is left to the in-app notice. The text is fixed per kind plus the repository's name; nothing from the task's message or log is used, so a URL or credential cannot reach it (checked by a test). The main process checks the request, shows it only when the window is not focused, and a click restores and focuses the window, selects the repository and opens the task list. Settings → General has a switch (on by default). A task that finishes between two polls without ever being seen running is not announced. Palette entry: none, since this is a setting rather than an action.
- Commit: see git log (`feat: complete U7.2 notify when long tasks end in the background`)

### U9.2 — Reflog view and lost-commit recovery
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (220 tests; new `reflog_api_finds_a_lost_commit_pages_and_lists_gitcrest_backups` throws two commits away with a hard reset, finds the lost commit in the reflog, checks the entries against `git rev-parse HEAD@{1}`, pages two at a time, reads a branch's own reflog, lists a GitCrest reset-backup ref with its kind, and covers 400, 401 and 404; plus unit tests for reference validation and parsing), `tsc --noEmit` (both configs), `pnpm build`, `pnpm frontend:boundaries`, `vitest run` (580 tests; new `reflog-dialog.test.tsx`), `pnpm test:e2e` (38 tests, after the build).
- Manual check: not run (app not started).
- Evidence: `crates/gitcrest-core/src/features/reflog/`, `src/features/history/ui/ReflogDialog.tsx`
- Limits / follow-up: `GET /repositories/{repoId}/reflog` reads HEAD or a local branch (`refs/heads/<name>` only; anything else is refused), newest first, 100 per page up to 500. The first page also lists GitCrest's rebase and reset safety refs with a "rebase backup" or "reset backup" label. The dialog opens from the command palette ("Show reflog and recover a lost commit"); there is no button for it elsewhere yet. Each row offers "Create branch here…", which opens the existing branch dialog at that commit, and "Reset to here…", which opens the existing reset dialog with the commit chosen; nothing is changed from the reflog itself, so recovery always goes through the reset preview, confirmation and backup ref. Both actions are disabled while a Git task runs. Reflog entries expire with Git's own settings, and a branch that was deleted has no reflog to open (its commits show in HEAD's reflog).
- Commit: see git log (`feat: complete U9.2 add a reflog view for recovering lost commits`)

### U10.4 — Recognize LFS pointer files
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (221 tests; new `lfs_status_reports_whether_git_lfs_is_installed_and_requires_a_token` compares the answer with `git lfs version` on the machine and covers 401), `tsc --noEmit` (both configs), `pnpm build`, `pnpm frontend:boundaries`, `vitest run` (589 tests; new `lfs-pointer.test.tsx` for parsing, the diff check, sizes and the notice), `pnpm test:e2e` (38 tests, after the build).
- Manual check: not run. No real LFS-tracked repository was opened, so how the diff API presents a pointer file when `git lfs` filters are active was not observed; the parser works on the pointer text the diff rows carry.
- Evidence: `src/features/diff/model/lfs-pointer.ts`, `tests/unit/lfs-pointer.test.tsx`
- Limits / follow-up: when both sides of a text diff are a Git LFS pointer, or one is and the other is empty, the main diff area and the Diff window show "LFS object changed: <object> · <size> → <object> · <size>" (or added or removed) in place of the three pointer lines, with a note that the content is stored with Git LFS. A new `GET /api/v1/git/lfs` reports whether `git lfs` is installed and its version, and the notice says so, with a pointer to git-lfs.com when it is missing. A pointer needs the version, oid and size lines and at most 12 short key-value lines; anything else stays an ordinary text diff. The plan also mentioned labelling pointers in status; that is not done, because telling a pointer from a normal file needs its content or its attributes for every row. Full LFS management stays in v1.5.
- Commit: see git log (`feat: complete U10.4 explain Git LFS pointer diffs`)

### U11.1 — Commit signing setup and failure help
- Status: done
- Tests: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (224 tests; new `signing_api_reads_the_setup_and_tests_a_real_signature_without_moving_anything` creates a real SSH key, reads the setup back, makes a real signature through Git, then points the key at a missing file and checks that the tool's own output comes back while HEAD, the commit count and the working tree stay unchanged; plus unit tests for the config parsing; the test skips when `ssh-keygen` is missing), `tsc --noEmit` (both configs), `pnpm build`, `pnpm frontend:boundaries`, `vitest run` (598 tests; new `signing.test.tsx` and a task-center case), `pnpm test:e2e` (38 tests, after the build). The failure patterns were checked against the real log of a signed commit whose GPG program was missing (`error: cannot spawn …`, `error: gpg failed to sign the data`, `fatal: failed to write commit object`).
- Manual check: not run. Only SSH signing was exercised for real; GPG and X.509 signing, and a passphrase prompt from a real agent, were not.
- Evidence: `crates/gitcrest-core/src/features/signing/`, `src/features/identity/ui/SigningSettings.tsx`
- Limits / follow-up: `GET /repositories/{repoId}/signing` returns the format (GPG, SSH or X.509), `user.signingkey` (an id, public key or file path; key material is never read), `commit.gpgsign` and the configured program. `POST /repositories/{repoId}/signing/test` has Git sign a throwaway commit of the empty tree with `commit-tree -S`; no branch or tag moves, no private key reaches GitCrest, and a failure is a normal answer carrying the tool's output (up to 2,000 characters) or a note after 60 seconds, since a passphrase prompt may be waiting. The test leaves one unreachable object in the repository for Git's normal clean-up to remove. Settings → General shows the facts and the "Test signing" button for the open repository. A commit task that failed because of signing now shows a help block in the task list with the signing tool's own lines and a button that opens Settings. The setup itself is still changed with `git config`; GitCrest does not edit it. As before (S2.5), a failed signature creates no commit.
- Commit: see git log (`feat: complete U11.1 show the signing setup and explain signing failures`)

### U1.2 — First-run hints and empty states
- Status: done
- Tests: `tsc --noEmit` (both configs), `pnpm build`, `pnpm frontend:boundaries`, `vitest run` (605 tests; new `hints-empty-states.test.tsx`), `pnpm test:e2e` (38 tests, after the build). No Rust or API change.
- Manual check: not run (app not started); the wording and placement of the hints were not looked at on screen.
- Evidence: `src/shared/hints/hints-store.ts`, `src/shared/ui/InlineHint.tsx`, `src/shared/ui/EmptyState.tsx`, `tests/unit/hints-empty-states.test.tsx`
- Limits / follow-up: four short hints, each shown once with a "Got it" button: at the top of the Changes panel (staging by tick, line or function), in the Shelves tab (shelves versus stash), at the top of the structure outline, and in the AI assistant (nothing is sent until you confirm). They are `role="note"` blocks, so a screen reader reads them in place without an alert and focus does not move. Dismissals are kept in local storage, and Settings → General has "Show tips again". The plan also named "safety previews" as a hint topic; there is no hint for it. Empty states: no changes (already had "Browse history"), no history (new "Go to Changes"), no remotes (new "Add a remote", opens the remote manager), no shelves (new "Shelve some changes…", opens the shelve dialog, with a reason when a Git task blocks it), no tags (new "Create a tag", on the selected commit or HEAD); a tag search with no matches stays a plain sentence. The empty branch list has no action. The actions work by keyboard because they are buttons. No modal tour was added.
- Commit: see git log (`feat: complete U1.2 add first-use hints and next steps to empty states`)
