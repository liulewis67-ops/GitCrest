---
name: GitCrest
description: A calm, precise desktop Git workbench
---

## Overview

GitCrest is an operating interface for reviewing changes and making deliberate Git operations. Its established direction is **quiet precision**: neutral surfaces, readable code, compact controls and clear state. The design-review plan explicitly preserves this direction.

Shipped code and this document describe the current system. Plans describe proposed changes; superseded specifications are historical. For exact runtime values, use `src/styles/tokens.css`, `src/styles/globals.css` and `src/features/settings/model/themes.ts`. User-selected appearance settings can override the built-in palette, typography, density and corners.

Git cues are welcome when they convey orientation: graph lane colours, the HEAD mark and Git-status colours. Colour also needs a label, shape or position to convey its meaning.

## Colors

The default theme follows the system. Dark CSS defaults are a boot fallback, not a user preference. Built-in light and dark themes use the same semantic roles; do not copy hexadecimal values into new components.

| Role | Token | Dark baseline | Light baseline |
|---|---|---|---|
| Application backdrop | `--canvas` | `#171b21` | `#f1f3f5` |
| Panel | `--surface` | `#1d232b` | `#fafbfc` |
| Elevated surface | `--surface-raised` | `#232a33` | `#fff` |
| Quiet surface | `--surface-soft` | `#20262e` | `#f4f6f8` |
| Divider | `--line` | `#333b46` | `#dfe4e9` |
| Strong boundary | `--line-strong` | `#424c59` | `#cbd3dc` |
| Content | `--text` | `#e6eaf0` | `#1d2732` |
| Supporting content | `--text-secondary` | `#a4afbd` | `#505c6a` |
| Metadata | `--text-muted` | `#8693a2` | `#646f7d` |
| Primary action / selection | `--accent` | `#6db6d8` | `#147ba5` |
| Hover / keyboard focus | `--accent-strong` | `#81c8e8` | `#086d98` |
| Text on primary action | `--on-accent` | `#10232c` | `#fff` |
| Success | `--green` | `#8fcba0` | `#287b46` |
| Warning (`--warning` alias) | `--amber` | `#d4b477` | `#8a641f` |
| Destructive action / error | `--danger` | `#d98787` | `#ab4d4d` |

Git state uses `--git-added`, `--git-modified`, `--git-deleted`, `--git-renamed`, `--git-untracked`, `--git-conflicted`, `--git-ignored`. In particular, untracked is neutral and conflicted is orange. Diff backgrounds and token highlights use `--diff-add-bg`, `--diff-del-bg`, `--diff-add-token`, `--diff-del-token`, `--diff-conflict-bg`, derived from those state colours. Syntax uses `--syntax-*`; coloured graph mode uses six `--graph-lane-*` tokens. Graph colouring defaults to accent-only and can be enabled in Appearance.

## Typography

UI stack: Inter, Segoe UI, Microsoft YaHei UI, PingFang SC, Noto Sans CJK SC, system sans-serif. Code stack: JetBrains Mono, Cascadia Code, SF Mono, Menlo, Consolas, system monospace. These are fallback stacks, not bundled-font promises.

| CSS token | Default size / utility line height | Use |
|---|---|---|
| `--type-2xs` | Alias of `--type-xs` | Kept for existing badge and metadata rules; new code uses `--type-xs` |
| `--type-xs` | 12 / 16px | Secondary labels, time, SHA |
| `--type-sm` | 13 / 18px | Controls and content |
| `--type-md` | 14 / 20px | Panel titles |
| `--type-lg` | 16 / 22px | Larger headings |
| `--type-xl` | 22 / 28px | Page headings |
| `--code-size`, `--code-leading` | 13 / 20px | Diff code |

Interface text follows `--font-scale`; `--type-xs` has a 12px floor at every interface text size, and no interface text goes below 12px. Code size is separately configurable. Weight is usually 400–500 for supporting text and 600–650 for controls and headings. Use the shared scale; verify computed sizes in every window.

## Layout

The main shell has a 40px titlebar and a flexible content row. Repository tabs, search, Tasks, Settings and connection state live in the titlebar. There is **no status bar**. The 44px repository toolbar anchors branch and sync actions on the left, centers the Workspace/History switcher and places Fetch all immediately after Push, and keeps panel controls on the right. Repository paths live in tab tooltips. Branch and sync state belong in the repository toolbar; operations run in the background with a small titlebar loading indicator. Task Center opens only on an explicit user request; failures use notices, and merge conflicts open the dedicated resolver.

There are **two repository views**, Workspace and History (`changes` and `history` in code). Workspace places the change tree and composer in the left Commit panel and the working-tree diff in the main area. History has repository objects in its sidebar, graph above the selected commit's changes, and an optional commit inspector. Branches is a sidebar section, not a third view. The composer is inside the Commit panel, not a bottom workbench across the window.

The branch picker includes current and remote tracking branches, favorites, sync counts, and the same shared branch context-menu builder as History. Fetch all updates the picker in place with task feedback; actions needing review close the picker before opening their existing workflow dialog. The branch list scrolls independently while the header, actions and shortcut hint remain visible.

View shortcuts default to Mod+1 / Mod+2; sidebar and inspector toggles use Mod+Shift+B / Mod+Shift+D. The complete binding list lives in `shortcut-preferences.ts`, and users may override it. Narrow windows show the inspector as an overlay; wide windows can dock it. See `ViewLayout.tsx`, `use-panel-preferences.ts` and `globals.css` for current sizing and breakpoints.

Spacing tokens are 4, 8, 12, 16 and 24px (`--space-1/2/3/4/6`). History defaults to 32px single-line rows (28px compact / 40px comfortable), with a compact search and branch row and a dismissible advanced-filter popover. Applied filters have removable chips. The sidebar defaults to 280px and the inspector to 300px; existing saved widths stay valid. Density scales list-row heights through `--density`; it does not shrink text. Diff and Conflict remain separate windows with restricted capabilities. Settings covers the current content inside the main window. Its native dropdown menus follow the active theme, checkbox labels stay inline, and automation modes use selectable comparison tiles. Navigation targets align to a consistent top inset, including short sections at the end; Escape dismisses an open dropdown before closing Settings.

## Elevation & Depth

The workspace toolbar presents worktree and branch as one compact, single-line context group, separated from synchronization actions by a neutral divider. Folder and branch icons identify each picker; the worktree name is secondary and the branch name leads. Both entries retain accessible labels and full-value tooltips, with long names truncated inside flexible controls. All toolbar controls share a 30px baseline. Below 1400px the view switcher follows the flexible context and sync area instead of forcing equal side columns. Both pickers anchor under their trigger and can be opened directly from one another. Row actions open one worktree or review one branch switch; separate checkboxes select targets for batch actions. Right-clicking a selected row acts on that selection; an unselected row starts a single-item context. Batch operations review the exact targets, execute serially, retain per-target results, and return focus to the picker. Pull is fast-forward only, Push never forces, and occupied or unmerged branches and dirty, locked, main or current worktrees retain their existing protections.

Resting panels use neutral surface steps and the shared 0.5px hairline divider token. Focus rings, icon strokes and semantic code markers keep their functional widths. Explicit UI weights use shared role tokens with a one-step dark-mode compensation. Overlays use `--shadow` (baseline `0 18px 56px`, black at 32% in dark and slate at 18% in light). Appearance can change shadow strength. Keep transient menus and dialogs visually above the workbench; do not add shadows to every list row.

## Shapes

Corners use `--radius-2/3/4/5/6/7/8/9/12`, multiplied by the user's `--radius-scale`. Controls usually use the 4–6px steps and dialogs the 8px step. Connection dots and graph nodes are circular. Keep borders aligned to the compact workbench grid.

## Components

Task flows show the current state and one nearby next action. The commit composer offers explicit staging, summary focus or conflict resolution as appropriate; extra description is optional and alternate commit actions remain in the split menu. No guidance executes a Git mutation on render.

Optional explanations use HelpDisclosure beside their control; first-use InlineHint content is collapsed by default. Hook editing leads with basic fields and targets, keeps confirmation visible, and groups merge/conflict options and commands behind labeled disclosures. Saving and cancelling return focus to the related rule or opener. AI request destinations, scope and explicit consent remain visible while full payloads are available on demand.

Disclosures and new dialog/status content may fade in over 160ms. Do not animate layout or transform ancestors of fixed-position menus. Honor both reduced-motion media preferences and the app motion setting, including focus-related scrolling.

Current shared UI includes Button, Dialog, DialogHeader, DialogFooter, Icon, BrandMark, ContextMenu, MenuButton, ResizeSeparator, WindowControls, EmptyState, InlineHint, NoticeRegion and ErrorMessage. API failures use translated recovery guidance; their original diagnostics sit behind a collapsed Details disclosure. Shared controls use global semantic CSS and existing tokens; no UI library dependency is required.

Unavailable repositories use RepositoryRecoveryPanel with Locate folder, Remove from list and optional Retry actions. RepositoryRemoveDialog reuses the existing removal confirmation in Welcome and the workspace; Cancel receives initial focus. Locate preserves the previous entry and saved data. Repository read failures keep synchronization actions disabled, with a visible reason, until a successful read.

Status and history failures replace the dependent view content with one main error and Retry action. Side panels show a neutral empty state; stale commit changes and inspector content are suppressed. Failed commit-detail reads have no SHA heading or continuing loading indicator. History pagination waits for an explicit retry after failure, so scrolling cannot replace the error or collapse its diagnostic disclosure.

Task Center groups tasks by repository name, newest first. Operation, status, phase and failure category use translated labels; completed tasks lead with a confirmed outcome and relative time. Only active tasks retain progress, and only running status is a live region. Raw Git diagnostics stay in the collapsed log disclosure. Current task snapshots do not include commit counts or remote targets, so outcomes do not invent them.

| Surface | Current styles and states |
|---|---|
| Primary button | `Button variant="primary"`, accent fill, on-accent text, 34px regular / 30px compact minimum height; stronger accent on hover and native disabled semantics |
| Secondary button | `Button variant="secondary"`, neutral fill/border and shared regular/compact sizes |
| Quiet / compact button | `Button variant="quiet"`, transparent neutral surface; `size="compact"` is 30px; regular is 34px |
| Danger action | Final destructive actions use `Button variant="danger"`, tinted background and danger text/border; never a text link |
| Inputs | Neutral surfaces, strong boundary, shared type scale; native disabled semantics and visible focus |
| Lists / refs | Selected and hover states use accent-soft or raised surfaces; Git-state text and reference badges retain their semantic roles |
| Menus | MenuButton and ContextMenu share visible inset focus, arrow/Home/End/Escape navigation, viewport fitting and grouped danger actions; internal scrolling keeps the menu open |
| Dialogs | Shared Dialog owns initial focus, trapped Tab, busy dismissal protection, Escape and return focus. DialogHeader supplies title and SVG close; DialogFooter aligns Cancel before the main action on the right. Workflow bodies retain their local layout. Settings makes background siblings inert and restores them before returning focus. |
| Feedback | NoticeRegion is the shared polite live region; InlineHint is dismissible instructional text; task cards show ongoing and completed work |

Focus on buttons, inputs, selects, textareas and separators uses a 2px `--accent-strong` outline with 2px offset; window controls inset their outline. Menu and working-list focus uses the same 2px outline inset to stay visible within rows. Preserve visible keyboard focus and disabled explanations when changing a component. Respect reduced-motion preferences; common hover transitions are 120ms ease-out.

Decorative action glyphs use the authored `shared/ui/Icon` SVG set: 16px viewBox, 1.5px rounded stroke and currentColor. Existing geometric Git diagrams and specialized SVGs remain local. Git direction/count notation (↑2 / ↓1), rename arrows within path data and image dimensions are content, not icon substitutes. Icon-only controls retain accessible names; decorative SVGs are hidden from assistive technology. No icon package is required.

## Do's and Don'ts

- Do use semantic CSS variables so both themes and custom palettes work.
- Do preserve the calm neutral direction and use Git colour where it explains state.
- Do keep destructive operations behind explicit review and show actionable errors in both languages.
- Do verify Workspace, History, Diff and Conflict at the review matrix sizes.
- Don't revive the historical third view, bottom workbench or status bar from superseded drawings.
- Don't treat historical visual proposals as shipped behavior.

The first-use changes hint keeps its title as an accessible label, uses compact guidance, and never wraps its dismiss label. At viewport heights up to 740px the composer uses compact visible option labels with full accessible names and a 52px initial resizable description. The default review fixture retains at least eight fully visible change rows at 960×700 in both languages and themes. Hints and notices use a neutral boundary without an accent stripe; notice severity is conveyed by text and its semantic indicator.

Semantic token aliases `--red`, `--success`, and `--surface-2` resolve to danger, green, and raised surface respectively, so legacy consumers follow both themes and custom palettes.

D3 palette rows show a description only for the selected command; unavailable commands live behind one expandable count, retaining focusable reasons without execution. Shortcut settings search names and current bindings across five task groups. Commit actions show their actual remapped shortcuts. Workflow footers stay outside scrolling content; Reset/Rebase start on their target field and emphasize review before final submission.

D4 Welcome leads with Recent repositories when populated. Open, Clone and Initialize share one action row; there is no preview-workspace action. The filter matches names, paths and branches. Each row has one Tab stop; ↑↓/Home/End move between rows and ←→ reach its secondary actions, as the visible hint explains. Availability and detached/in-progress states have a shape and accessible label beside status color. The repository toolbar and recent branch labels identify HEAD; new appearance preferences use colored graph lanes, preserving explicitly saved choices.

Text status roles `--status-added/deleted/renamed/modified/untracked` mix the underlying Git color with content text for readable small labels and selected states. The original Git colors still own backgrounds and graph/syntax preferences. Placeholders explicitly use text-muted with full opacity; recent paths use text-secondary; remote prefixes no longer apply faded opacity; HEAD badges use a neutral surface. Diff options group secondary settings, and the narrow structure rail stays in flow instead of covering headers. Palette arrow scanning preserves the search input; menu Tab advances beyond the trigger, while Escape returns to it. Reset recovery is a collapsed secondary disclosure after the impact/acknowledgement.

Duplicate recent names include the shortest distinguishing parent suffix beside the project name, with full paths retained. Structure onboarding leads with one short instruction and puts its longer explanation behind Learn how. Reset mode choices state their consequences, show only the selected explanation and keep a comparison disclosure. The titlebar Help entry opens a searchable local task guide for review/staging, commits/signing, synchronization, branch/history work and recovery; it displays current remapped bindings and uses the shared modal lifecycle.


## Conflict resolution

The conflict window uses a continuous three-pane workspace: read-only Current version, one editable Result, and read-only Incoming version. Git marker syntax is projected out of the result. Unresolved regions start from ancestor text (or a current-side proposal when the ancestor is unavailable) and remain visibly highlighted and pending. Source gutter arrows apply a change into the result and disappear after acceptance; undo restores both the decision and its arrows. Editing a pending result region directly supplies its manually composed output, including same-line combinations of both sources. Context edits preserve unrelated decisions. Full base inspection and unapplied Smart Merge candidates stay secondary. Accepting a conflict moves real keyboard focus to the next unresolved range, or keeps it in the result after the last conflict.

The footer stays outside the scrolling workspace. Save draft remains separate from staging; a marker-free dirty result offers Save & mark resolved, while an already saved result offers Mark resolved. Incomplete markers prevent completion. Whole-file replacement and reconstruction live under File actions and use the same unsaved-edit confirmation. Unavailable menu actions can retain keyboard focus with a visible explanation.

The file list collapses below 1100 CSS px; below 860px the result stays beside one selectable source. Short windows use compact spacing and retain an editable area. Pane ratios persist, source scrolling remains independent, and conflict jumps align only unambiguous source matches. Source highlights are bounded and fall back to readable plain text with an explanation.

The editor owns one undo history for typing, conflict choices, replacement, and AI acceptance. Line-ending metadata follows editor versions to retain CRLF, mixed endings, and missing final newlines. Large atomic text input is applied as one transaction. Reconnection preserves an unsaved draft and its reviewed source snapshot, even if that file disappears from the current conflict list; discarding that recovered draft requires explicit confirmation.

Completion offers Return to Task Center. The main process derives the destination from the registered conflict window, retains the restricted conflict token, and waits for the main renderer to acknowledge navigation to the existing task. Returning never continues the Git operation automatically.
