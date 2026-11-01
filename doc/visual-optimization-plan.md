# GitCrest Visual Optimization Plan

Status: Phase 1 completed; Phases 2–4 proposed.
Current baseline (2026-11-01): [DESIGN.md](../DESIGN.md) and shipped code take precedence. The diagnosis below is historical; Phases 2–4 contain proposals, not a description of today's app. Design-review D0–D2 are complete; D3/D4 are authorized next. The current two-view layout, sidebar composer and no-status-bar decision supersede older drawings here. Density and graph-colour preferences already exist and need evaluation rather than reimplementation.
Scope: renderer UI (`src/`), main window first, then the Diff and Conflict windows
Related specs: [05-uiux-spec.md](05-uiux-spec.md), [06-design-language.md](06-design-language.md), [07-interaction-accessibility.md](07-interaction-accessibility.md)

This plan looks at the UI from two sides:

- **Visual experience**: what the eye sees first, how easy the text is to read, and whether the screen looks calm and deliberate.
- **Usage experience**: how many steps the daily loop takes (review → stage → commit → push), how much useful content fits on the first screen, and whether actions are where the hand expects them.

Every finding below was measured in the running renderer (Vite + the real `gitcrest-core`, this repository opened, dark theme, zh locale) at 1440×900 and 1366×728. 1366×728 is the usable client area of a common 1366×768 laptop.

---

## 1. Diagnosis: what is wrong today

### 1.1 Text is far smaller than the design spec

The design language sets UI text at 13px and code at 13–14px ([06-design-language.md §3](06-design-language.md)). The renderer uses much smaller sizes almost everywhere.

Font-size declarations across `src/` (CSS and Tailwind arbitrary values):

| Size | Count | | Size | Count |
|---|---|---|---|---|
| 7px | 3 | | 12px | 16 |
| 8px | 31 | | 13px | 7 |
| 9px | 67 | | 14px | 8 |
| 10px | 76 | | ≥15px | 10 |
| 11px | 39 | | | |

About **75% of all declarations are 10px or smaller**. Measured computed sizes:

| Element | Now | Spec |
|---|---|---|
| Diff code lines (`.splitDiffCell`) | **9px** | 13px |
| Diff column labels / hunk header | 8px | 11–12px |
| Diff scope badge | 7px | 11px |
| Changed-file paths, branch names | 9px | 12–13px |
| Panel headings, status bar | 8–9px | 11–12px |
| Commit graph meta / SHA | 9px | 11–12px |
| Commit graph subject | 11px | 13px |
| Commit message textarea | 12px | 13px |

The default UI language is Chinese. CJK glyphs at 8–9px lose strokes and become hard to read, so the problem is worse for the main audience. This is the biggest single cause of a "cramped, hard to read" impression.

### 1.2 The first screen gives the main content too little height

Vertical budget of the workspace (graph mode):

| Band | Height | Content |
|---|---|---|
| Titlebar | 46px | brand, page tabs, repo tabs, search, theme, tasks, settings, engine status |
| Workspace toolbar | 40px | breadcrumb + full path, Graph/Diff, Push/Pull/Fetch, branch |
| Main panel heading | 36px | "Commit graph" title, "Local" tag, Refresh |
| History filters | 108px | 8 always-visible filter fields in 2 rows |
| **Graph viewport** | **flex** | **commits** |
| Main panel footer | 28px | "history is local" + version |
| Resize handle | 6px | |
| Commit workbench | 204px | working-tree summary, staged summary, commit form |
| Status bar | 25px | engine status + version (again) |

Measured result:

| Window | Graph viewport | Share of window | Commits fully visible (52px rows) |
|---|---|---|---|
| 1440×900 | 407px | 45% | **7** |
| 1366×728 | 235px | 32% | **4** |

On a standard laptop the user sees **four commits**. Chrome above and below the graph takes 493px.

### 1.3 The same information appears more than once

| Information | Where it appears now |
|---|---|
| Engine connection state | titlebar badge, sidebar footer, status bar (3 places) |
| Engine version | main panel footer, status bar, welcome footer |
| Unstaged / staged counts | sidebar Changes groups **and** the first two workbench columns |
| Repository path | repo tab tooltip, toolbar breadcrumb, repository details |
| View name | toolbar Graph/Diff tabs **and** main panel heading |

The two left columns of the commit workbench (about 2/3 of a 1440×204 band) only show sentences like "No unstaged changes" or "Nothing staged". That space is mostly used to repeat the sidebar.

### 1.4 Weak visual hierarchy

- **Everything has the same weight.** Panel headings, group titles, metadata and buttons all use small muted text with letter-spacing. Nothing tells the eye where to start.
- **The primary action is small.** "Commit" is a compact button in the bottom-right corner of the workbench, the same visual weight as the Amend/Sign-off checkboxes beside it.
- **The current branch is not prominent.** The branch name, the user's most important piece of context, is the last item in the toolbar, rendered as a quiet 10px button.
- **The commit details order is reversed.** The details panel shows SHA, then six action buttons (Copy SHA, Tag, Merge, Cherry-pick, Revert, Branch here), then author/date, and only then the commit message. The panel heading says "Repository" while it shows a commit.
- **Commit graph rows are tall but thin on information.** Rows are 52px high with an 11px subject and 9px meta: low density, weak contrast between subject and meta.
- **Ignored files are listed under Changes** (`dist/`, `node_modules/`, `out/` …) next to real changes. That adds noise to the most-used list.
- **The welcome page** has a 49px hero headline while the recent repository list, which is the actual work, uses 10px names and 9px paths. "Favorites first" looks like a button but can't be clicked.

### 1.5 Usage friction

- History filters (SHA, author, message, branch, path, since, until) are always expanded, even though most sessions never filter.
- Branch row actions only appear on hover, use Unicode glyphs (↪ ⤴ ⧉) with 20px hit targets, and can't be found without a mouse.
- The sidebar stacks Changes, Branches (capped at 168px), Worktrees, Remotes and Shelves in one scroll. At 1366×728 the content is 564px in a 407px panel, so Remotes and Shelves sit below the fold.
- Diff mode stacks four sticky headers (file meta 37 + navigation 30 + column labels 27 + hunk header 29 = **123px**) before the first line of code.
- Icons are Unicode characters (`⑂ ◌ ⌁ ⇢ ⤴ ⧉ ◐ ⌕`). They render differently on Windows, macOS and Linux fonts, don't line up on the baseline, and some fall back to emoji-style glyphs.

---

## 2. Design principles for the optimization

1. **Content first.** The commit graph, the change list and the diff are the product. Chrome (headings, footers, repeated status) has to justify every pixel.
2. **One focal point per region.** Each region has exactly one element at emphasis level 1 (see §5.1).
3. **Readable by default, dense by choice.** A 13px base with a user-selectable density mode, instead of shrinking type to fit.
4. **Say it once.** Each piece of state has one home. Other places link to it.
5. **The daily loop stays on one screen.** Review → stage → write message → commit → push without scrolling or moving the eye across the window.
6. **Calm color.** Neutral surfaces. Color is reserved for Git state (added/modified/deleted/conflict), the current branch/HEAD, focus, and danger.

---

## 3. Target layout and initial screen ratio

### 3.1 New window frame

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ◆ GitCrest   [repo-a ×] [repo-b ×] [+]        ⌕ Search commands  Ctrl+K   ⚙ ●  │ 40  Titlebar
├───────────────────────────────────────────────────────────────────────────────┤
│ ⑂ main ▾  ↑2 ↓0 │ Fetch  Pull  [Push ↑2] │      [ Graph | Diff ]      ⟳  ⋯   │ 36  Repo toolbar
├──────────────┬────────────────────────────────────────────────┬───────────────┤
│ CHANGES   6  │ ⌕ Filter commits…   Branch: All ▾   [Filters]  │ fd59a12  main │
│ ▸ Staged  0  │────────────────────────────────────────────────│ feat: pick    │
│ ▾ Unstaged 2 │ ● feat: pick the initial UI langu…  lewis  2h  │ the initial … │
│   ? new file │ │ docs: add Git management impl…  lewis  2h  │ lewis · 2h ago│
│   ? tsconfig │ │ feat: add English and Chinese…  lewis  1d  │ ───────────── │
│              │ │ …  (≈ 23 rows at 1440×900)                 │ 2 files +21 −3│
│──────────────│ │                                            │  i18n/index.ts│
│ Message      │ │                                            │  i18n.test.ts │
│ ┌──────────┐ │ │                                            │ ───────────── │
│ │          │ │ │                                            │ Cherry-pick ⋯ │
│ └──────────┘ │ │                                            │               │
│ [ Commit ▾ ] │ │                                            │               │
│──────────────│ │                                            │               │
│ Branches ▸   │ │                                            │               │
│ Remotes  ▸   │ │                                            │               │
│ Shelves  ▸   │ │                                            │               │
├──────────────┴────────────────────────────────────────────────┴───────────────┤
│ No status bar: engine/tasks in titlebar; branch/upstream in repository toolbar │
└───────────────────────────────────────────────────────────────────────────────┘
```

Key moves:

| # | Change | Height saved |
|---|---|---|
| L1 | Titlebar 46 → 40px. Remove the Welcome/Workspace page tabs (the brand mark returns to Welcome, and so does closing the last repo). Move the theme toggle into Settings and the command palette. Shrink the engine badge to a dot whose tooltip has the detail. | 6 |
| L2 | Toolbar 40 → 36px. Drop the breadcrumb and full path; the path goes into the repo tab tooltip and the details panel. The **branch switcher moves to the far left** and becomes the toolbar's anchor, with ahead/behind counts. Graph/Diff becomes a centered segmented control. Refresh moves here as an icon. | 4 |
| L3 | Remove the main panel heading row. The view name already lives in the segmented control. | 36 |
| L4 | History filters collapse into one 36px search row: a free-text box (SHA, message or author, detected automatically), a branch dropdown, and a "Filters" button that opens path/date filters as a popover. Active filters show as removable chips in the same row. | 72 |
| L5 | Remove the main panel footer and the sidebar footer. No status bar. Engine state and task progress stay in the titlebar; branch state stays in the repository toolbar. | 31 |
| L6 | **Move the commit composer into the left sidebar** under the Changes list (the JetBrains / VS Code / Fork pattern). Remove the bottom workbench and its redundant summary columns. | 210 |

### 3.2 Initial screen ratio targets

| Window | Graph viewport now | Target | Share now → target | Commits visible now → target (32px rows) |
|---|---|---|---|---|
| 1366×728 | 235px | ≈ 594px | 32% → **82%** | 4 → **18** |
| 1440×900 | 407px | ≈ 766px | 45% → **85%** | 7 → **23** |
| 1920×1080 | ≈ 587px | ≈ 946px | 54% → **88%** | 11 → **29** |

Horizontal split targets at 1440px wide: sidebar 280px (19%), main ≥ 840px (58%+), details 300px (21%). The sidebar default grows from 236 to 280px because it now holds the composer. Existing per-repo stored widths stay valid; only the defaults and clamps change.

### 3.3 Fallback if the composer stays at the bottom

If moving the composer is too large a change for one release, the minimum acceptable step is:

- Collapse the bottom workbench into a single 2-row composer (message + action row, ≈ 96px), with no summary columns.
- Let the user minimize it to a 32px bar ("6 changes · 0 staged · Write commit message…") that expands on focus or `Ctrl+Enter`.

That alone moves 1366×728 from 4 to roughly 12 visible commits.

---

## 4. Typography

### 4.1 Type scale (replace ad-hoc px values with tokens)

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `--text-2xs` | 11 / 14 | 500 | badges, kbd, counts. **Absolute minimum; nothing smaller.** |
| `--text-xs` | 12 / 16 | 400–500 | metadata, timestamps, SHA, status bar, section labels |
| `--text-sm` | 13 / 18 | 400 | **default UI text**: lists, buttons, inputs, paths |
| `--text-md` | 14 / 20 | 600 | commit subject in the details panel, dialog titles |
| `--text-lg` | 16 / 22 | 600 | empty-state titles, settings section titles |
| `--text-xl` | 22 / 28 | 600 | welcome headline (down from 49px) |
| `--code-sm` | 13 / 20 | 400 mono | diff, conflict editor, blame |

Rules:

- **11px is the floor.** All 7–10px values are removed.
- Section labels use `--text-xs`, weight 600, sentence case or plain CJK. Drop the `.08–.14em` uppercase tracking: it reads as decoration, and letter-spacing breaks CJK.
- Numbers (counts, ahead/behind, `+12 −3`, SHAs, dates in lists) use `font-variant-numeric: tabular-nums`.
- The code font stack follows the spec: `"JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Consolas, monospace`. Currently `--font-mono` starts with `ui-monospace` and doesn't list JetBrains Mono.
- On Windows, add `"Microsoft YaHei UI"` and on macOS `"PingFang SC"` to `--font-ui` after Segoe UI, so Chinese text gets a proper UI face instead of the browser fallback.

### 4.2 Element mapping

| Element | Now | Target |
|---|---|---|
| Repo tab label | 10px | 13px |
| Toolbar buttons / mode switch | 10px | 13px |
| Branch switcher (toolbar) | 10px | 13px, weight 600 |
| Panel / group headings | 8–10px uppercase | 12px, weight 600 |
| Changed-file path | 9px | 13px; directory part muted, file name in normal text color |
| Branch name | 9px | 13px |
| Commit graph subject / meta | 11 / 9px | 13 / 12px |
| Details commit subject | 12px | 14–16px, weight 600 |
| Diff code | **9px** | **13px / 20px line-height** |
| Diff headers / hunk header | 7–9px | 12px |
| Status bar | 8px | 12px |
| Welcome headline / repo names | 49 / 10px | 22 / 13px |

---

## 5. Color and visual emphasis

### 5.1 Emphasis levels

| Level | What it is | How it's drawn | Examples |
|---|---|---|---|
| L1 – Primary action | the one thing to do next in a region | filled accent button, 32px tall | Commit, Open repository, Resolve |
| L2 – Current state | where the user is | accent text or 2px accent indicator, weight 600 | current branch, HEAD node, selected row, active tab |
| L3 – Content | what the user reads | `--text`, 13px | commit subjects, file paths, code |
| L4 – Metadata | supporting facts | `--text-secondary`, 12px | author, date, SHA, counts |
| L5 – Chrome | structure | `--line`, `--text-muted` | dividers, inactive tabs, placeholders |

Rule: **at most one L1 per region.** Push is L1 in the toolbar only when there are commits to push (`↑n > 0`); otherwise it is a quiet button.

### 5.2 Tokens to add or adjust (`src/styles/tokens.css`)

- **Git status colors** from the spec (`--git-added`, `--git-modified`, `--git-deleted`, `--git-renamed`, `--git-untracked`, `--git-conflicted`, `--git-ignored`) don't exist as tokens yet. Add them for both themes and use them for file badges, the diff gutter, graph ref badges and filters.
- **Diff backgrounds**: `--diff-add-bg`, `--diff-del-bg`, `--diff-add-token`, `--diff-del-token`, `--diff-conflict-bg` per [06-design-language.md §2.3](06-design-language.md).
- **Graph lane palette**: 8 hues with distinct lightness, checked against `--canvas` in both themes (≥ 3:1 for non-text marks). Lane 0 (the first-parent line of the current branch) uses `--accent`.
- **Selection**: `--selection-bg` (current `--accent-soft`) plus a 2px `--accent` left indicator on selected list rows, as the spec asks for the commit graph.
- **Surface steps**: dark `--canvas #171b21` and `--surface #1d232b` are only about 3% apart in lightness, so the panes blur together. Either widen the gap a little (e.g. canvas `#14181d`) or rely on 1px `--line` dividers alone and use a single surface. Pick one; don't use both.
- **Contrast check**: `--text-muted #7c8998` on `--canvas` is about 4.7:1. That's acceptable at 12px+, but not at the current 8–9px. With the new scale, the muted color is fine for L4/L5. Placeholder text must stay ≥ 4.5:1.

### 5.3 Where emphasis moves

| Region | Now | Target |
|---|---|---|
| Toolbar | branch is the last quiet button | branch switcher first, 13px/600, with an `↑2 ↓0` pill; Push shows its count and becomes L1 when there is something to push |
| Commit graph | HEAD looks like other nodes; selection = soft background | HEAD node: larger ring in `--accent`; current branch ref badge filled; selection: background + 2px left bar; merge commits dimmed subject |
| Changes list | ignored files mixed in; status letter in a box | ignored group hidden by default (toggle in the list menu); conflicts pinned at the top with `--git-conflicted` row tint; colored status letter without a box |
| Details panel | actions before message | commit subject first (L3, 14–16px), then author/date/SHA (L4), then files, then actions in a footer row (one visible + overflow menu) |
| Composer | Commit button same weight as checkboxes | full-width L1 Commit button; Amend / Sign-off / GPG move into the split-button menu or an options popover; the button label shows the effect ("Commit 3 files to main") |
| Welcome | hero dominates | when recents exist, they are the hero: large list, the first item focused, `Enter` opens it. The marketing hero only appears when the list is empty |

---

## 6. Component-level plan

### 6.1 Titlebar (`src/app/layouts/AppTitlebar.tsx`)
- Height 40px. Order: brand mark → repo tabs → spacer → command search → tasks (only shown when tasks are running, with a progress ring) → settings → engine dot.
- Repo tabs: 13px, max-width 180px, close button visible on hover/active only, plus a `+` tab that opens the Welcome/Open flow.
- Remove the page tabs and the text theme button.

### 6.2 Repository toolbar (`src/pages/workspace/WorkspacePage.tsx`)
- Left: branch switcher + ahead/behind. Middle-left: Fetch / Pull / Push group with icons + text, and counts on Pull/Push. Center: Graph | Diff segmented control. Right: refresh, overflow (`⋯`: open in terminal/editor/file manager).
- Disabled buttons must say why in a tooltip. The reasons already exist in props.

### 6.3 Sidebar (`src/pages/workspace/WorkspaceNavigation.tsx`)
- Two parts: **Changes + composer** (top, takes the space it needs) and **Repository objects** (Branches, Worktrees, Remotes, Shelves) as collapsible sections, each with its own count and its own scroll limit. Collapsed state is saved per repo.
- Changes rows: 28px height, checkbox-style stage toggle on the left (spec §2.2), status letter, file name (L3) + directory (L4, truncated in the middle), `+a −d` on the right.
- Staged / Unstaged as collapsible groups; "Stage all / Unstage all" become icon buttons in the group header instead of two full-width buttons.
- Branch rows: 28px; the current branch is pinned on top with an accent indicator; local before remote; remote rows use L4 color (the spec asks for remote branches to look weaker). Row actions show on hover **and** on keyboard focus/selection, and every action is also in the right-click menu.

### 6.4 Commit graph (`src/features/history/ui/CommitGraph.tsx`)
- Row height 52 → **32px** (Default density), 28px (Compact), 40px (Comfortable).
- Single-line rows with columns: graph | subject + ref badges (flex) | author (120px) | relative date (90px, absolute in tooltip) | short SHA (72px, mono). The columns can be resized or hidden through a header context menu.
- Lane spacing 20 → 14px at 32px rows. Node radius 4px; HEAD 6px with a ring.
- The filter row is described in §3.1 L4. The search keyword is highlighted in subjects.

### 6.5 Details panel (`src/pages/workspace/WorkspaceDetailsPanel.tsx`, `CommitDetails.tsx`)
- Heading shows "Commit" (not "Repository") when a commit is selected.
- Order: subject → body (collapsed after 6 lines) → author avatar initials + name + date → SHA / parents as copyable chips → changed files (tree/flat toggle) → action bar (Cherry-pick visible, the rest in `⋯`).
- With no commit selected: show the repository summary (branch, upstream, last fetch time, remotes), not the "no commit selected" placeholder.

### 6.6 Diff view (`src/features/diff/ui/SplitDiff.tsx`)
- Merge the four sticky headers into **one 36px header**: scope badge + path (file name emphasized) + `+a −d` | hunk navigation `↑ ↓ 2/5` | whitespace toggle | Stage/Discard | open in window. Column labels (Old / New) become a faint overlay in the gutter. The hunk header becomes an inline separator row (24px).
- Header height before code: 123 → about 36px.
- Code 13/20px mono; line numbers 12px L4; word-level highlights use the diff token colors.
- Hide the details panel in Diff mode (already specified) and let the sidebar collapse with `Ctrl+B` for a full-width diff.

### 6.7 Commit composer (`src/features/commits/ui/CommitWorkbench.tsx`)
- Subject field (single line, with a 50/72 character counter that turns `--warning` past 72) + body textarea (grows from 3 lines).
- The template select moves into the field's left adornment or the `⋯` menu. "AI suggestion" becomes an icon button inside the field.
- Full-width split button; sensitive-file and amend advisories show as one inline banner above the button, not as small text below it.

### 6.8 Welcome page (`src/pages/welcome/WelcomePage.tsx`)
- With recents: a compact header ("Open repository", "Clone", "Init" as one button row) and then the recent list as the main content (13px name, 12px path, branch, last-opened time, favorite star). Type-to-filter and keyboard navigation.
- Without recents: the current hero, scaled to `--text-xl`, plus the three quick actions.
- The fake "Favorites first" button becomes plain label text or a real sort toggle.

### 6.9 Status bar
- **Superseded in D0.3:** no status bar. Keep engine state and Task Center access in the titlebar, and branch/upstream in the repository toolbar. Do not add a footer to meet this older proposal.

### 6.10 Iconography
- Replace the Unicode glyphs with one SVG icon set. Recommended: `lucide-react` (tree-shakable, MIT, 1.5px stroke fits the "quiet precision" tone). Icons are 16px in toolbars and 14px in rows, always `currentColor`.
- This adds a dependency, so it needs a go-ahead (see §10). The alternative is a small local `src/shared/ui/icons/` set of about 25 hand-made SVGs.

---

## 7. Usage-experience improvements

| Area | Change | Why |
|---|---|---|
| Density | Add Settings → Appearance → Density (Compact / Default / Comfortable), driving row heights and spacing through CSS variables. Don't scale type below 12px. | The spec already lists a "compact mode"; users who want density get it without everyone paying in readability |
| Hit targets | Minimum 24×24px for icon buttons, 28px row height | branch actions are 20px now |
| Keyboard | `↑/↓` move in every list, `Space` stages/unstages the focused file, `Enter` opens its diff, `Ctrl+B` toggles the sidebar, `Ctrl+Alt+B` toggles details, `F7/Shift+F7` move between hunks | the loop can be done without the mouse |
| Discoverability | Every hover action is also in the context menu and the command palette | hover-only actions are invisible to keyboard users |
| Feedback | Push/Pull/Fetch show inline progress in the button + Task Center; success shows a 2s toast with an Undo where it exists | today the only feedback is the task count |
| Empty states | One short sentence + one action per [05-uiux-spec.md §6](05-uiux-spec.md), using `--text-lg` titles; remove the decorative "clear view" eyebrow | the current empty states are mostly decoration |
| Motion | 120ms ease-out for hover/press/expand; no motion on list virtualization; respect `prefers-reduced-motion` | calm and fast |
| Persistence | Keep the current per-repo layout storage; add collapsed sections, density and column visibility to it | |

---

## 8. Responsive behavior

| Width | Sidebar | Main | Details |
|---|---|---|---|
| ≥ 1440px | 280px | flex | 300px |
| 1200–1439px | 260px | flex | 260px |
| 960–1199px | 240px | flex | drawer over the main area, toggled from the toolbar |
| < 960px | 48px icon rail; expands as an overlay | flex | drawer |

Height: below 700px, keep the commit composer compact. No status bar is added; branch state remains in the repository toolbar.

---

## 9. Rollout in phases

Each phase can ship on its own and leaves the app consistent.

### Phase 1 – Readability (low risk, highest impact)
- Add the type-scale tokens; replace every 7–10px value; set diff code to 13/20px.
- Add Git status, diff and lane color tokens.
- Add CJK fonts to the font stack.
- **Accept when:** no computed font-size under 11px in the main window, Diff window or Conflict window (checked by a script over all elements); diff code is 13px. The live-window check runs in `tests/e2e/readability.ts` from the desktop and conflict E2E flows.
- **Done 2026-10-19.** Notes:
  - The scale lives in `tokens.css` as `--type-2xs … --type-xl`, `--code-size` and `--code-leading`. Tailwind gets matching `text-2xs … text-xl` utilities through `@theme inline`.
  - Git state colors are `--git-*` tokens, diff backgrounds are `--diff-*` tokens. Untracked files now use a neutral gray instead of the added-green, and conflicts use their own orange instead of the deleted-red.
  - Four variables that were used but never defined are fixed: `--red`, `--success`, `--text-primary`, `--danger-soft`. Because of them, the force-push button and failed tasks weren't red, and unified-diff additions had no background.
  - The `button, input, textarea { font: inherit }` reset moved into `@layer base`. Unlayered, it overrode every Tailwind text utility on buttons.
  - Wide letter-spacing on small labels is removed.
  - The graph lane palette was deferred initially. Lane tokens are now present and used when colored graph lanes are enabled; the default remains neutral.
  - Side effect: the bigger filter labels make the history filters 9px taller (graph 407 → 398px at 1440×900). Phase 2 collapses the filters and recovers this.
  - Rechecked 2026-10-31 in live Electron E2E runs: the main, Diff and Conflict windows have no visible text below 11px, and split-diff code computes to 13px. The check caught a 10.4px `<small>` label in the Conflict window; the base style now gives semantic small text an 11px floor.

### Phase 2 – Initial screen ratio
- L1–L5 from §3.1, subject to DESIGN.md: slimmer titlebar and toolbar, no main heading or footers, collapsed history filters, no status bar. Engine state and tasks remain in the titlebar.
- Commit graph rows at 32px with single-line columns.
- Fallback composer (§3.3) if Phase 3 isn't scheduled right after.
- **Accept when:** graph viewport ≥ 75% of window height at 1366×728 and ≥ 80% at 1440×900; ≥ 16 commits visible at 1366×728.

### Phase 3 – Layout restructure
- Composer in the sidebar (L6); sidebar sections collapsible; details panel reordered; diff header merged.
- **Accept when:** the stage → commit → push loop needs no scrolling at 1366×728 with up to 10 changed files; diff code starts ≤ 40px below the main area top.

### Phase 4 – Emphasis and polish
- SVG icon set; L1–L5 emphasis rules applied; HEAD/selection styling; welcome page recents-first; density setting; responsive drawers.
- **Accept when:** a screenshot review of 1366×728 and 1920×1080, dark and light, zh and en (8 shots for the main window + Diff + Conflict) passes the checklist in §11.

---

## 10. Decisions needed before implementation

1. **Composer location**: ~~move it into the sidebar (recommended, §3.1 L6), or keep it at the bottom in the collapsible form (§3.3)?~~ **Decided 2026-10-19: the composer moves into the left sidebar (§3.1 L6).** The §3.3 fallback is not needed.
2. **Icon set**: add `lucide-react`, or hand-maintain local SVGs?
3. **Dark surface strategy**: widen the canvas/surface contrast, or flatten to one surface with dividers?
4. **Page tabs**: OK to remove the Welcome/Workspace tabs and reach Welcome through the brand mark and the `+` tab?
5. **Spec updates**: [05-uiux-spec.md §2.5](05-uiux-spec.md) still describes the bottom workbench with unstaged/staged columns. If decision 1 goes the recommended way, that section and [09-wireframes.md](09-wireframes.md) need to be updated in the same change.

---

## 11. Verification checklist

Measurement (run in the renderer devtools; this is the same script used for the numbers in §1):

```js
const v = document.querySelector('.historyWorkspace .graphViewport').getBoundingClientRect();
const rows = [...document.querySelectorAll('.commitGraphRow')]
  .filter(e => { const r = e.getBoundingClientRect(); return r.top >= v.top && r.bottom <= v.bottom; }).length;
const tiny = [...document.querySelectorAll('body *')]
  .filter(e => e.childElementCount === 0 && e.textContent.trim() && parseFloat(getComputedStyle(e).fontSize) < 11);
({ ratio: (v.height / innerHeight).toFixed(2), rows, tinyText: tiny.length });
```

Screenshot checklist (each size × theme × language):

- [ ] The current branch and its ahead/behind can be read within one second of looking at the window.
- [ ] Each region has exactly one filled (L1) button.
- [ ] No text below 11px; diff code 13px.
- [ ] No piece of state shown in two places.
- [ ] Changes shows no ignored files by default; conflicts sit at the top.
- [ ] All icons come from one set and line up with the text baseline.
- [ ] Focus rings are visible on every interactive element; all hover actions can also be reached by keyboard.
- [ ] Light theme: Git status colors and lane colors keep ≥ 3:1 against the surface.

Tests: the e2e suite mostly selects by role, aria-label and title, plus a few class names (`.taskCard`, `.taskStatus`). Removing visible text (page tabs, panel headings, the breadcrumb) or moving the composer can still break role/name lookups. Each phase must update the affected tests in the same change and keep `pnpm check` green.
