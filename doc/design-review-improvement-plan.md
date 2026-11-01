# Design Review Improvement Plan

Status: D0–D4 complete. Updated: 2026-11-01.
Scope: visual presentation and interaction of the desktop renderer (`src/`), the core error contract and repository metadata persistence needed for safe removal, and the design documents in `doc/`.
Related: [07-interaction-accessibility.md](07-interaction-accessibility.md) (keyboard, feedback and safety rules), [visual-optimization-plan.md](visual-optimization-plan.md) (earlier visual plan, Phase 1 shipped), [ux-functional-improvement-plan.md](ux-functional-improvement-plan.md) (functional gaps, U stages), [15-frontend-development-guidelines.md](15-frontend-development-guidelines.md) (frontend rules).

This plan comes from a design critique on 2026-10-31. Unlike the earlier reviews, it ran the app: one reviewer inspected the live window and read the docs and code, and a second ran the Impeccable detector against the source and the running window over CDP. The archived report is `.impeccable/critique/2026-10-31T09-42-27Z__src-app-app-tsx.md`.

The result was **23/40 (Acceptable)**. The safety design and the token system are a strong base. Ease of use breaks down in error and feedback states, the surfaces drift because there is no shared component layer, and the design documents no longer agree with each other or with the code.

Decisions taken after the review:

- **Order:** errors and feedback come first.
- **Tone:** keep the calm, neutral look, and add Git-specific cues (graph lane colours, a HEAD mark, Git-status colours) where they help orientation.
- **Scope now:** D0/D1 complete. On 2026-11-01 the user authorized continuing through D2, then D3/D4, with a commit at each completed phase.

---

## 1. How to use this plan

- Stage IDs are `D<stage>.<n>`. Each stage is one commit, with the same rules as `13` §2: code, tests and the status change in this file land together, with an English commit message such as `feat: complete D1.2 recovery actions for a missing repository`.
- Status values: **not started, in progress, awaiting acceptance, done, blocked, deferred**.
- Every stage that adds UI text adds both English and Chinese strings in `src/shared/i18n/messages/`.
- Every UI stage runs the screenshot matrix from D0.2 before and after, and attaches the changed captures to the commit description or a PR.
- A stage is done only after `pnpm check` passes and its pass rule below is met.

Priority: **P1** causes real difficulty or confusion, **P2** an annoyance with a workaround, **P3** polish. Size: **S** ≤ 1 day, **M** 2–4 days, **L** about a week.

## 2. Findings this plan answers

| Finding | Priority | Evidence | Stage |
|---|---|---|---|
| Error states show raw English core text, repeat the same error up to five times, and offer no recovery | P1 | `crates/gitcrest-core/src/api/error.rs:225`; `src/pages/workspace/CommitPanel.tsx:283`; history view shows a spinner that never stops | D1.1–D1.3 |
| A repository whose folder is gone still shows a green "available" dot on Welcome, and Fetch/Pull/Push stay enabled | P1 | `src/pages/welcome/WelcomePage.tsx`, `src/pages/workspace/BranchesSidebar.tsx` | D1.2 |
| Task Center prints internal fields: operation id, status, phase and a 64-character repo id | P1 | `src/features/tasks/ui/TaskCenter.tsx:91-92` | D1.4 |
| The first-run hint's "知道了" button wraps one character per line | P2 | `.inlineHint` in `src/styles/globals.css:1593` | D1.5 |
| No shared Button/Dialog: 3 dialog shells, 2 close styles, both footer alignments, buttons at 34/30/29/26px, danger actions as links in 15 places and buttons in 2 | P1 | `globals.css:176-203, 1065, 1187` | D2 |
| Menu focus is a 9% tint with `outline: none`; long menus overflow; Reset is not styled as dangerous | P2 | `globals.css:148, 252, 480, 538` | D3 |
| Command palette lists 42 disabled commands with no repo, shows about 6 two-line rows, mixes shortcut spellings | P2 | `src/app/layouts/CommandPalette.tsx` | D3 |
| Welcome puts a marketing hero above the recent-repository list; actions duplicated | P2 | `src/pages/welcome/WelcomePage.tsx` | D4 |
| Contrast misses: recent-repo paths 4.1:1, Settings diff preview 4.1–4.2:1, placeholders 3.0:1 | P2 | `WelcomePage.tsx`, `globals.css:1289-1290` | D4 |
| Design documents contradict each other and the code | P1 | §3 below | D0.3 |

Correction from checking the code while writing this plan: the core **already** returns a typed `ApiErrorCode` with every error (`error.rs:112`), and the renderer already reads it in a few places (`use-commit-submission.ts:86`, `use-repository-push.ts:103`). D1.1 therefore needs no API change; it maps the existing codes to translated text in the renderer.

## 3. Document conflicts to resolve in D0.3

D0.3 resolved the current-state conflicts below. D2 chose global semantic classes for shared components; D3.2 adopted a single expandable unavailable-command count; current styling and palette behavior are explicitly recorded in DESIGN.md and `15`/`07`.

| Conflict | Documents | Resolution |
|---|---|---|
| Colour values and type scale differ from the shipped tokens; dark is called the default though the app follows the system | `06` vs `src/styles/tokens.css` | `tokens.css` wins; `DESIGN.md` records it; `06` marked superseded for colour and type |
| Three views with Ctrl+1/2/3, a bottom workbench and a status bar | `03`, `05`, `09` vs the app (two views: 工作区 / 历史) | The app wins; `05` and `09` marked superseded |
| Status bar: "none" vs a target layout and checklist that assume one | `03` vs `visual-optimization-plan.md` §3.1, §6.9, §11 | Decide once in `DESIGN.md`; recommendation: no status bar, matching the app |
| Palette shows or hides unavailable commands | `07` §2 vs U5.1 | D3.2 collapsed them into one expandable row, with focusable reasons retained |
| shadcn, `shared/ui` primitives and Tailwind-only styling | `15` vs the code (global CSS classes, no primitives, `cn()` unused) | D2 chose global semantic classes and updated `15` to match |
| Status headers say "not implemented" / "nothing started" | `visual-optimization-plan.md`, `ux-functional-improvement-plan.md` | Update the headers to the real status |

Precedence rule to add to `00-README.md`: **shipped code and `DESIGN.md` describe what is; plan documents describe what should change; superseded documents are history only.**

## 4. Summary of stages

| ID | Stage | Priority | Size | Depends on | Status |
|---|---|---|---|---|---|
| D0.1 | Seeded review fixture repository | P1 | S | — | done |
| D0.2 | Screenshot matrix script | P1 | M | D0.1 | done |
| D0.3 | `DESIGN.md` and document precedence | P1 | M | — | done |
| D1.1 | Translated error messages from API codes | P1 | M | — | done |
| D1.2 | Missing-repository detection and recovery | P1 | M | D1.1 | done |
| D1.3 | One error per view; no endless loading | P1 | S | D1.1 | done |
| D1.4 | Readable Task Center | P1 | M | — | done |
| D1.5 | Fix the first-run hint layout | P2 | S | — | done |
| D1.6 | Stage D1 re-evaluation | P1 | S | D1.1–D1.5, D0.2 | done |
| D2 | Shared Button and Dialog components | P1 | L | D0.3 | done |
| D3 | Keyboard and palette efficiency | P2 | L | D2 | done |
| D4 | Welcome, contrast and Git cues | P2 | M | D0.3 | done |

## 5. Stage D0: make evaluation repeatable

### D0.1 Seeded review fixture repository

Both throwaway repositories used during the review had been deleted from disk, so the commit graph, diff view, Monaco editor and commit composer could only be judged from code.

- Add `scripts/review-fixture.mjs` that builds on `tests/fixtures/temp-repo` and creates, in a folder passed as an argument (default under the system temp folder):
  - about 30 commits across `main`, two feature branches and one merged branch, with two tags;
  - a local branch ahead of and behind a bare "remote" in the same temp folder, so sync arrows show;
  - staged, unstaged and untracked changes, including a renamed file, a binary image and a file long enough for structure navigation;
  - an optional `--conflict` mode that leaves a merge in progress with two conflicted files.
- Print the created path so it can be opened in the app.

**Pass rule:** running the script twice gives two valid repositories; `git status` and `git log --graph` work in both; the app opens them and shows graph, diff and composer content.

**Done 2026-11-01.** `node scripts/review-fixture.mjs [new-folder] [--conflict]` prints the repository path. Each run creates a new isolated folder; the normal mode includes 26 commits across the requested branches, two tags, a local bare origin, a 1-ahead/1-behind main branch, staged/unstaged/untracked/renamed/binary changes and a long TypeScript file. Conflict mode leaves exactly two unmerged paths and excludes unrelated edits so recovery remains safe. Existing destinations are refused. Both modes were checked with Git; `tests/e2e/review-fixture.test.ts` opens fresh data in an isolated Electron profile and verifies changes, Monaco diff, composer and graph. `pnpm check` passed (703 frontend, 334 Rust and 42 desktop E2E tests).

### D0.2 Screenshot matrix script

- Add `scripts/review-screenshots.mjs` that attaches to a running `pnpm debug` window over CDP (`127.0.0.1:9222`) with Playwright and captures:
  - **States:** Welcome; Workspace with changes; History with a commit selected; diff (split and unified); conflict window (fixture `--conflict`); Settings (General, Appearance, Shortcuts); command palette with and without a repository; Task Center after a fetch; one dialog (create branch); one error state (a repository whose folder was removed).
  - **Variants:** 1280×816 and 960×700; light and dark.
- Write captures to an ignored folder (`.review/screens/<date>/`) with stable file names so two runs can be compared side by side.
- The script restores the window it found: route, theme and size.

**Pass rule:** one command produces the full matrix (14 states × 2 sizes × 2 themes) from a fresh fixture without manual steps.

**Done 2026-11-01.** Start `pnpm debug`, then run `node scripts/review-screenshots.mjs` (`--cdp URL` and `--output folder` are optional). The runner creates local fixtures, registers only its own repositories, waits for rendered diff/history content, and writes stable state/size/theme names plus `manifest.json` beneath ignored `.review/screens/`. It captures in English and restores the original locale and local preferences. Electron lacks native window sizing over renderer CDP, so exact CSS viewports are emulated without moving the native window. Cleanup forgets only the runner's repositories, closes its conflict window and restores route, theme and viewport; the final run verified the restored theme and dimensions. Windows folder moves retry brief sharing violations. The final baseline in `.review/screens/d0-baseline/` contains 56 unique PNGs, all dimension-checked. `pnpm check` passed (703 frontend, 334 Rust, 42 E2E).

**Cleanup follow-up 2026-11-01:** the resolver is captured last and reused across its four variants, so main-window reloads cannot repeatedly reopen a waiting review task. Cleanup aborts only fixture workflows, waits for both the original and recovery tasks and their metadata refreshes, then forgets fixture entries and closes secondary windows created by the run. Failed recovery retains fixture registration while restoring the original UI. Reopening the moved-back error fixture refreshes cached availability between variants. A fresh-profile run verified all 56 images, exact dimensions, one remaining original window, zero waiting tasks and zero fixture repositories.

### D0.3 `DESIGN.md` and document precedence

- Generate `DESIGN.md` at the repository root from the shipped code (`/impeccable document`): tokens, type scale, spacing, colour roles including Git-status colours, component list with variants and states, dialog anatomy, focus rules, icon policy.
- Record the tone decision: calm and neutral, with Git cues (graph lane colours, HEAD mark, status colours) allowed on first-screen surfaces.
- Resolve every row in §3, add the precedence rule to `00-README.md`, and add a "Superseded by DESIGN.md" note at the top of `05`, `06` (colour and type sections) and `09`.
- Update the status headers of `visual-optimization-plan.md` and `ux-functional-improvement-plan.md`.

**Pass rule:** no two documents in `doc/` give different values for the same token, view count or layout element; every superseded document says so in its first lines.

**Done 2026-11-01.** Root `DESIGN.md` documents shipped light/dark colour roles, type and spacing scales, configurable density/corners, component states, dialog/focus behavior and the current mixed icon inventory. It preserves the agreed calm neutral direction with meaningful Git cues. `00` defines precedence; `03` now describes two views and the sidebar composer; `05`, `06` and `09` identify superseded material in their opening lines. The visual plan's status-bar proposal is retired, its historical/proposed status is explicit, and `15` removes its competing palette example and records actual CSS/Tailwind usage with Button/Dialog deferred to D2. At D0.3, `07` and U5.1 agreed on the then-current unavailable-command behavior; D3.2 subsequently implemented its collapsed-row proposal. The UX status header reflects its completed ledger. `git diff --check` and `pnpm check` passed; no renderer behavior changed.

## 6. Stage D1: errors and feedback

### D1.1 Translated error messages from API codes

- Add `src/shared/i18n/api-errors.ts` that maps each `ApiErrorCode` (from `src/api/schema.ts`) to a translated message with three parts: **what happened**, **likely cause**, **what to do**. Example for `REPOSITORY_STATUS_FAILED`: "无法读取此仓库的工作区状态 / 文件夹可能已移动、删除，或 .git 目录已损坏 / 定位文件夹，或从列表中移除。"
- Route `GitCrestApiError` display through one helper (for example `describeApiError(error, t)`) instead of rendering `error.message`. Keep the core's English message available in a "详情" disclosure for bug reports.
- Unknown codes fall back to a generic translated message plus the details disclosure, never the raw string alone.
- Add a unit test that every `ApiErrorCode` in the schema has both an English and a Chinese entry.

**Pass rule:** with the UI in Chinese, no screen in the D0.2 error state shows English text outside the details disclosure.

**Done 2026-11-01.** `describeApiError` maps every current API code to English/Chinese guidance explaining the problem, likely cause and recovery. Renderer error state now keeps diagnostics separately from its message; shared `ErrorMessage` exposes them through a keyboard-accessible, initially collapsed Details disclosure. Unknown codes use translated generic guidance. Existing local validation strings remain supported, and text-only notifications/tooltips use `errorText`. The transport's raw error contract is unchanged. Exhaustive schema coverage lives in tests to preserve the shared-layer import boundary. `pnpm check` passed: 707 frontend tests, 334 Rust tests and 43 desktop E2E tests, including a Chinese missing-path response and four real repository-opening failures with diagnostic disclosure. Before/after matrices are `.review/screens/d0-baseline/` and `.review/screens/d1.1-after/` (56 captures each). Source detection found 11 existing stripe warnings; live detection found the existing Inter and Welcome contrast findings tracked for later work. Screenshot inspection confirmed readable error guidance and collapsed diagnostics; error deduplication remains D1.3.

### D1.2 Missing-repository detection and recovery

- When Welcome lists recent repositories, check that each path still exists (a cheap `stat` through the existing bridge or a core endpoint) and show a distinct "不可用" state instead of the green dot.
- Reuse the existing codes: `REPOSITORY_PATH_NOT_FOUND` and `NOT_A_REPOSITORY` mean the folder moved or lost its `.git`; `REPOSITORY_STATUS_FAILED` and `HISTORY_UNAVAILABLE` on an existing folder mean Git could not read it.
- Opening an unavailable repository shows one recovery panel with **定位文件夹…** (pick the new location and re-open it) and **从列表中移除**.
- In a workspace whose repository cannot be read, disable Fetch, Pull and Push with a visible reason, as `07` requires for disabled actions.

**Pass rule:** delete a fixture repository's folder while the app is closed; on next launch Welcome marks it unavailable, and both recovery actions work. An E2E test covers it (extend `tests/e2e/repository-management.test.ts`).

**Done 2026-11-01.** Recent repositories reuse the core's existing path-availability check. Missing folders and typed repository-read failures expose translated Locate, Remove and Retry actions. Locate opens the selected folder and preserves the old entry and saved GitCrest data; removal uses the existing explicit confirmation. Unreadable repositories disable synchronization buttons, handlers, shortcuts and palette commands with a visible reason, retaining the failure until a read succeeds. Desktop tests cover restart after moving a folder, locating it, confirmed removal without deleting files, and blocked synchronization followed by successful retry. Before/after matrices are `.review/screens/d1.1-after/` and `.review/screens/d1.2-after/` (56 each). The runner now restores the original workspace before cleanup, stopping late fixture reads; verification found one original window, no waiting tasks and no newly registered fixture repositories. Source detection reports the same 11 existing stripe findings. Live pixel detection was unavailable because Electron reported a hidden surface; the actual light/dark error captures were inspected. `pnpm check` passed (707 frontend, 334 Rust and 45 desktop E2E tests). Dependent history content still duplicates failures and is addressed in D1.3.

**Removal-race follow-up done, 2026-11-01.** Matrix cleanup exposed a real core race: metadata refresh called the insert-capable open path after removal. Metadata inspection now saves through an update-only catalog operation, preserving favorites and recent-open time; explicit Open remains able to re-register a folder. A deterministic Rust test forgets the entry between the catalog read and metadata save, and a second checks preserved preferences and fresh HEAD data. Ephemeral contexts remain unregistered. The runner reloads after removal before verifying cleanup, exercising persisted task refreshes as well. Formatting, Clippy and all 336 Rust tests passed. A fresh-profile 56-image run and a subsequent registry check verified zero repositories, zero waiting tasks and one restored 1280×816 light window. The final D1 check also passed with this follow-up (713 frontend, 336 Rust and 47 desktop E2E tests).

### D1.3 One error per view; no endless loading

- When status or history fails, show the error once in the main area of the view. Side panels that depend on the same data show an empty state, not a copy of the error.
- Stop the loading indicator in the commit pane when history fails, and hide the commit SHA heading when no commit was loaded.
- Retry stays available in the single error panel.

**Pass rule:** in the D0.2 error state, each view shows exactly one error message and no spinner remains after the request fails.

**Done 2026-11-01.** A history failure keeps the graph and its Retry action mounted, expands it into the main area, and replaces dependent branches with a neutral empty state while hiding commit changes and the inspector. Status errors similarly replace stale workspace content and leave an empty sidebar. Commit-detail failures render one Retry panel without a SHA heading or loading state. Pagination no longer retries a failed history read on scroll, preserving the error and its expanded diagnostic disclosure. Tests cover explicit retry after failed history/commit reads, and the Chinese desktop error test checks one alert and no spinner in both views. `pnpm check` passed (709 frontend, 334 Rust and 45 desktop E2E tests). Before/after matrices are `.review/screens/d1.2-after/` and `.review/screens/d1.3-after/` (56 unique, dimension-checked images each); light/dark error captures confirm one panel without dependent stale content. Source detection reports the same 11 stripe findings; live detection reports the existing Inter and Welcome contrast findings. The delayed review-fixture metadata race discovered here is fixed by the D1.2 removal follow-up above.

**Selected-commit follow-up done, 2026-11-01.** A commit-detail failure now suppresses the dependent inspector until the primary read succeeds; Retry restores the inspector with fresh data. A primary history failure suppresses a secondary refs warning, and a paginated Retry retains the reported repository failure until completion. Unit coverage checks that retained failure and the error observer; a desktop test opens the inspector, fails a selected commit, verifies one visible error without a SHA heading or spinner, then verifies successful Retry restores the inspector. Empty Monaco announcement containers are excluded from error-message counts. The final combined D1 check passed (713 frontend, 336 Rust and 47 desktop E2E tests); the D1.5/D1.6 matrices verify the final error layout.

### D1.4 Readable Task Center

In `src/features/tasks/ui/TaskCenter.tsx`:

- Translate `operation`, `status` and `phase` through i18n keys (`tk.op.*`, `tk.status.*`, `tk.phase.*`) instead of rendering them raw.
- Show the repository **name** (from the repository list) instead of `repoId`; fall back to the last folder name of `targetPath`.
- Lead each finished task with one outcome sentence, for example "已推送 3 个提交到 origin/main", built from the task result; show a relative time ("2 分钟前").
- Group tasks by repository, newest first; drop the progress bar once a task has finished.
- Only the running task's status keeps `role="status"`; finished cards are plain text, so screen readers are not flooded.
- Translate `errorCategory` labels.

**Pass rule:** after a fetch, a push and a failed clone in the fixture, Task Center shows no raw identifiers, and each card can be understood without knowing the API.

**Done 2026-11-01.** Task Center groups tasks by repository display name, newest first; target-folder names are used for clones and a translated fallback for unknown repositories. Operations, status, phases and failure categories are translated, including dynamic shelf operations and unknown future values. Finished cards lead with an outcome and relative time, omit progress bars and have no live status role. Raw Git diagnostics remain in the collapsed log. The current TaskSnapshot API has no structured result, commit count or remote target, so outcomes use confirmed operation/status facts rather than inventing counts or parsing logs. Chinese unit coverage includes successful fetch/push and failed clone; existing real desktop workflows check the new outcomes and metadata visibility. The final combined `pnpm check` passed (713 frontend, 336 Rust and 47 desktop E2E tests), including both pull-conflict recovery paths with translated task labels. Before/after matrices are `.review/screens/d1.3-after/` and `.review/screens/d1.4-after/` (56 each), with the final frozen build also captured in D1.5/D1.6. Source detection retains the same 11 stripe findings.

### D1.5 Fix the first-run hint layout

- Give the `.inlineHint` dismiss button `white-space: nowrap` and `flex-shrink: 0`, and let the text wrap instead.
- Reduce the hint's height in the commit pane (about 120px today) so it does not push the change list down on a 700px-tall window.
- Replace the coloured left stripe with the shared notice style chosen in D2, or keep it until D2 and note it there.

**Pass rule:** at 960×700 and 1280×816, in light and dark, the button text stays on one line and the change list shows at least 8 rows below the hint.

**Done 2026-11-01.** The changes hint uses shorter English/Chinese guidance and keeps its title as an accessible label without a repeated visual heading. Dismiss labels never shrink or wrap. At 740px height and below, composer options use compact visible labels while preserving their full accessible names and tooltips, and the description starts at 52px while remaining resizable. The normal review fixture now has ten real change rows without changing its commit graph, ahead/behind relation or conflict-mode safety. Prototype captures measured eight visible rows at 960×700 and nine at 1280×816 in both languages and themes; `tests/e2e/hint-layout.test.ts` passed on the built layout, checking a one-line dismiss label and at least eight fully visible file rows in all eight size/theme/language variants. The final `pnpm check` passed (713 frontend, 336 Rust and 47 desktop E2E tests). Before captures are `.review/screens/d1.5-before/`; after captures are `.review/screens/d1.5-layout/` (eight layout variants) and `.review/screens/d1.5-after/` (56-state matrix). Source detection retains the same 11 stripe findings. The existing coloured stripe is retained until D2 chooses the shared notice style.

### D1.6 Stage D1 re-evaluation

- Run the D0.2 matrix and `/impeccable critique` again, and compare with the 2026-10-31 baseline.
- Record the new scores in this file under §9.

**Pass rule:** heuristic 9 (error recovery) at 3 or more, heuristic 1 (system status) at 3 or more, and no new P1 findings.

**Done 2026-11-01.** The frozen D1 tree passed `pnpm check` (713 frontend, 336 Rust and 47 desktop E2E tests). `.review/screens/d1.6-after/` has 56 unique dimension-checked captures. With explicit user approval, two isolated reviewers inspected the same seeded app sequentially and restored it. Assessment A scored **30/40**, with system status **3/4**, error recovery **3/4**, and no new P1 observed. Its complete saved report survived a usage-limit error during final delivery. Assessment B independently ran the source detector and five visible live scans; it found 11 source stripe warnings and 23 repeated live findings, including credible History HEAD (3.9:1) and remote-prefix (3.0:1) contrast misses. Semantic markers, font popularity and repeated dimmed-background findings were adjudicated separately. The archived synthesis is [D1.6 critique](../.impeccable/critique/2026-11-01T04-49-59Z__src-app-app-tsx.md). Sampling and accessibility limitations are explicit; this is not an exhaustive accessibility certification.

Remaining P2 findings: palette hints disagree with actual view shortcuts (D3.2); staged-count summary truncates at narrow widths; narrow History spends too much room on diff configuration; signing choices need concise local explanations. Contrast/icon findings remain D4. D2 subsequently removed the hint stripe using the shared neutral notice boundary, covered the full-page Settings edge and isolated its background. These are future improvements, not hidden completion claims. The user subsequently authorized D2–D4 in that order; these findings are tracked in those stages.

## 7. Continuing stages (authorized 2026-11-01)

### D2 Shared Button and Dialog components

- Add `Button` (primary, secondary, quiet, danger; regular and compact) and `Dialog` (header with title and an × close, body, right-aligned footer with Cancel before the main action, initial focus, focus returned to the opener on close) to `src/shared/ui`.
- Move the 30 dialogs onto `Dialog`; dangerous final actions use the danger `Button`, never a text link.
- Choose one styling approach (Tailwind or global classes) and update `15` to match.
- Define the colour variables that are used but never defined: `--red`, `--success`, `--surface-2` (`globals.css:1600-1602, 1639-1640, 1671`).
- Mark the full-page Settings view's background `inert`.

**Done 2026-11-01.** D2 uses global semantic CSS and existing tokens, with no new UI dependency. Button owns four tones and regular/compact sizing. Dialog owns the modal lifecycle, header/close, footer, nested confirmation focus and full-page background isolation. The inventory contains 32 dialog-role surfaces (including the palette, Settings and nested confirmation), all migrated; specialized body layouts remain local. Baseline: `.review/screens/d2-before/` (56 captures). Focus, busy-dismissal and inert-restoration tests accompany existing workflow coverage. The neutral shared notice boundary also replaces the hint/notice accent stripe. `pnpm check` passed: 716 frontend, 336 Rust and 48 desktop tests, including real Settings inert/focus restoration and the long Reset operation. After: `.review/screens/d2-after/` (56 captures); affected narrow/dark Create branch and full-page Settings were compared against baseline. Independent sequential critique scored 31/40 (target ≥28), with no P0/P1 observed; archive `.impeccable/critique/2026-11-01T05-26-57Z__src-app-app-tsx.md`. Source detector: nine functional/intentional stripe records; five live states: 50 repeated records, with Settings background occlusion false positives excluded. Remaining workflow initial focus, safe-next-step emphasis, scrolling footers and Cancel consistency move into D3; measured text contrast remains D4.

### D3 Keyboard and palette efficiency

- **D3.1** A visible focus style for menu and list items (2px inset outline or a left bar); menus flip upward when they would overflow; destructive menu items grouped and coloured as dangerous.
- **D3.2** Command palette: one-line rows with the description shown only for the selected row; unavailable commands collapsed into one "需要仓库 (N)" row; one shortcut formatter used everywhere; give Ctrl+1 one meaning.
- **D3.3** Keyboard staging in the change tree: arrow keys to move, Space to stage or unstage, Enter to open the diff.
- **D3.4** Shortcut settings: search box and groups; shortcuts shown in the commit ⋯ menu.

**Done 2026-11-01.** D3 delivers: shared menu placement/navigation, inset focus and separated destructive groups; collapsed unavailable palette commands with selected descriptions and actual shortcut bindings; keyboard file staging; searchable grouped shortcut settings and commit-menu bindings. D2 review follow-ups move Reset/Rebase focus into the target field, emphasize preflight, keep workflow footers visible, and standardize ordinary Cancel. Staged counts stay visible while the branch summary can truncate; signing controls have local descriptions. Baseline: `.review/screens/d3-before/` (56 fresh captures). `pnpm check` passed (722 frontend, 336 Rust, 48 desktop tests), including keyboard staging/unstaging/Enter review, remapped shortcut persistence, Reset recovery and eight visible rows in both languages/themes/sizes. Final after matrix: `.review/screens/d3-final/` (56 captures), which is also the fresh unchanged baseline for D4. Independent sequential critique scored 32/40 with no P0/P1 observed; archive `.impeccable/critique/2026-11-01T06-07-17Z__src-app-app-tsx.md`. Source detector retains nine semantic/functional stripes; five live scans produced 71 overlapping records with hidden Settings background false positives excluded. Follow-ups in the final pass: continuous palette typing, menu Tab progression, Reset recovery hierarchy and narrow diff/header occlusion; contrast/icons remain D4.

### D4 Welcome, contrast and Git cues

- When recent repositories exist, the list becomes the main element of Welcome, with arrow-key navigation and one Tab stop per row; one row of actions; remove "预览工作区".
- Fix the contrast misses listed in §2 and add a `::placeholder` rule that uses `--text-muted`.
- Replace Unicode glyph icons (⌕ ↗ ⇣ ＋ → ⋯ ▾ ×) with one icon set.
- Add the Git cues from the tone decision: graph lane colour and a HEAD mark on the current branch in the titlebar or branch switcher, and status colours in the recent list.

**Done 2026-11-01.** D4 delivers: recent-first Welcome with one action row, repository filtering, one Tab stop per row and arrow access to secondary actions; semantic status text contrast, explicit placeholders, neutral HEAD badges and readable metadata; shared authored SVG icons; toolbar/recent HEAD cues and colored graph lanes for new preferences. The final D3 review follow-ups preserve palette search focus, move menu Tab onward, collapse Reset recovery after the current impact review, and keep the narrow structure rail in flow. Fresh boundary baseline: `.review/screens/d3-final/` (56 captures, unchanged D3 build); Final D4 after: `.review/screens/d4-final/` (56 captures; the earlier `.review/screens/d4-after/` records the first review iteration). Rendered default-theme contrast/navigation coverage is in `tests/e2e/visual-cues.test.ts`. The initial independent D4 design review scored 30/40 and identified narrow hint density, duplicate checkout identity, selected Reset consequences and task-level help as improvements. Those were addressed with shorter disclosed guidance, distinguishing parent labels, consequence-first mode text and a searchable local Help guide. A fresh isolated final design assessment scored **34/40**, exceeding the ≥32 target, with no P0/P1/P2 issue established in the sampled flows. The combined archive is `.impeccable/critique/2026-11-01T06-37-08Z__src-app-app-tsx.md`. `pnpm check` passed: **728 frontend, 336 Rust, 49 desktop tests**. The final detector update verified selected History additions at 5.9055:1 light / 7.3991:1 dark and found no confirmed priority issue; source retains nine semantic/functional stripe records, final live History light/dark and Help scans contain only font/reading-measure advisories. Three P3 polish items remain: narrow structure summary truncation, repeated Reset blocker wording and guide shortcut captions. NVDA announcement behavior is untested, not asserted as a failure. The requirement evidence audit, five complete 56-image matrix audits and zero-fixture/zero-active-task review cleanup are retained under `.review/`; the owned Electron process exited successfully. The initial detector verified all requested new contrast targets in both themes; its extra History added-count miss (4.4978:1) now uses the stronger status-text role as well.

## 8. Evaluation method

For every stage from D1 on:

1. Build a fresh fixture (D0.1) and capture the screenshot matrix (D0.2) before the change.
2. Make the change; run `pnpm check`.
3. Capture the matrix again and compare the affected states side by side.
4. Run `impeccable detect --json src` and, with the app open, `impeccable detect --cdp 9222 --target localhost:5173 --json`. Known false positives (split-diff gutter borders, ours/theirs and diff-row markers, text hidden under the full-page Settings dialog) are not counted.
5. At the end of each stage group (D1, D2, D3, D4), run `/impeccable critique` and record the score in §9.

Score targets: **28/40 or more after D2**, **32/40 or more after D4**.

## 9. Score log

| Date | After | Score | P0 | P1 | Notes |
|---|---|---|---|---|---|
| 2026-10-31 | Baseline | 23/40 | 0 | 3 | Graph, diff and composer judged from code only (fixture repositories were missing) |
| 2026-11-01 | D1 | 30/40 | 0 | 0 new observed | Independent sequential design/detector reviews; system status 3/4, error recovery 3/4; 56 fresh captures; final check 713 frontend / 336 Rust / 47 E2E. Contrast and P2 efficiency findings remain later work. |
| 2026-11-01 | D2 | 31/40 | 0 | 0 observed | Independent design/detector reviews; 32 shared dialog surfaces, 56 after captures; check 716 frontend / 336 Rust / 48 E2E. D3 workflow efficiency and D4 contrast findings remain explicit. |
| 2026-11-01 | D3 | 32/40 | 0 | 0 observed | Independent design/detector reviews; visible focus, bottom-edge menu fitting and persistent Reset footer verified; check 722 frontend / 336 Rust / 48 E2E; 56 final captures. |
| 2026-11-01 | D4 final | 34/40 | 0 | 0 observed | Initial 30/40 review findings addressed before fresh independent final review; 56 final captures; final check 728 frontend / 336 Rust / 49 E2E; default-theme text contrasts pass. Three P3 polish items and NVDA coverage boundary documented. |
