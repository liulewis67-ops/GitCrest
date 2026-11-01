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
| `--type-2xs` | 11 / 14px | Small badges and compact metadata |
| `--type-xs` | 12 / 16px | Secondary labels, time, SHA |
| `--type-sm` | 13 / 18px | Controls and content |
| `--type-md` | 14 / 20px | Panel titles |
| `--type-lg` | 16 / 22px | Larger headings |
| `--type-xl` | 22 / 28px | Page headings |
| `--code-size`, `--code-leading` | 13 / 20px | Diff code |

Interface text follows `--font-scale`; the smallest size has an 11px floor. Code size is separately configurable. Weight is usually 400–500 for supporting text and 600–650 for controls and headings. Use the shared scale; verify computed sizes in every window.

## Layout

The main shell has a 46px titlebar and a flexible content row. Repository tabs, search, Tasks, Settings and connection state live in the titlebar. There is **no status bar**. Branch and sync state belong in the repository toolbar; task feedback belongs in Task Center and notices.

There are **two repository views**, Workspace and History (`changes` and `history` in code). Workspace places the change tree and composer in the left Commit panel and the working-tree diff in the main area. History has repository objects in its sidebar, graph above the selected commit's changes, and an optional commit inspector. Branches is a sidebar section, not a third view. The composer is inside the Commit panel, not a bottom workbench across the window.

View shortcuts default to Mod+1 / Mod+2; sidebar and inspector toggles use Mod+Shift+B / Mod+Shift+D. The complete binding list lives in `shortcut-preferences.ts`, and users may override it. Narrow windows show the inspector as an overlay; wide windows can dock it. See `ViewLayout.tsx`, `use-panel-preferences.ts` and `globals.css` for current sizing and breakpoints.

Spacing tokens are 4, 8, 12, 16 and 24px (`--space-1/2/3/4/6`). Density scales list-row heights through `--density`; it does not shrink text. Diff and Conflict remain separate windows with restricted capabilities. Settings covers the current content inside the main window.

## Elevation & Depth

Resting panels use neutral surface steps and 1px dividers. Overlays use `--shadow` (baseline `0 18px 56px`, black at 32% in dark and slate at 18% in light). Appearance can change shadow strength. Keep transient menus and dialogs visually above the workbench; do not add shadows to every list row.

## Shapes

Corners use `--radius-2/3/4/5/6/7/8/9/12`, multiplied by the user's `--radius-scale`. Controls usually use the 4–6px steps and dialogs the 8px step. Connection dots and graph nodes are circular. Keep borders aligned to the compact workbench grid.

## Components

Current shared UI includes BrandMark, ContextMenu, MenuButton, ResizeSeparator, WindowControls, EmptyState, InlineHint, NoticeRegion and ErrorMessage. API failures use translated recovery guidance; their original diagnostics sit behind a collapsed Details disclosure. A shared Button and Dialog are **planned in D2**, not implemented yet.

Unavailable repositories use RepositoryRecoveryPanel with Locate folder, Remove from list and optional Retry actions. RepositoryRemoveDialog reuses the existing removal confirmation in Welcome and the workspace; Cancel receives initial focus. Locate preserves the previous entry and saved data. Repository read failures keep synchronization actions disabled, with a visible reason, until a successful read.

| Surface | Current styles and states |
|---|---|
| Primary button | `.primaryButton`, accent fill, on-accent text, 34px minimum height, 6px radius; stronger accent on hover, 1px pressed movement, neutral disabled state |
| Secondary button | `.secondaryButton`, neutral fill/border, same regular size; quiet hover and disabled text |
| Quiet / compact button | `.quietButton` is 30px minimum height; `.compact` is 26px; quiet hover raises the neutral surface |
| Danger action | `.dangerButton` and `.dangerTextButton` currently coexist; D2 will consolidate final destructive actions |
| Inputs | Neutral surfaces, strong boundary, shared type scale; native disabled semantics and visible focus |
| Lists / refs | Selected and hover states use accent-soft or raised surfaces; Git-state text and reference badges retain their semantic roles |
| Menus | MenuButton and ContextMenu support disabled reasons, danger items and keyboard navigation; focus contrast and long-menu behavior are D3 review items |
| Dialogs | Existing shells vary. Anatomy is a titled header, body and action footer; use `useDialogFocus` for initial focus, trapped Tab, Escape and return to opener. A standard close button and right-aligned Cancel/main-action footer are D2 targets |
| Feedback | NoticeRegion is the shared polite live region; InlineHint is dismissible instructional text; task cards show ongoing and completed work |

Focus on buttons, inputs, selects, textareas and separators uses a 2px `--accent-strong` outline with 2px offset; window controls inset their outline. Some menu styles override this and remain tracked in D3. Preserve visible keyboard focus and disabled explanations when changing a component. Respect reduced-motion preferences; common hover transitions are 120ms ease-out.

Icons currently mix local SVGs and Unicode glyphs. Keep accessible names on icon-only buttons, hide decorative icons from assistive technology, and use `currentColor`. A unified SVG set is planned; no new icon dependency is required by this document.

## Do's and Don'ts

- Do use semantic CSS variables so both themes and custom palettes work.
- Do preserve the calm neutral direction and use Git colour where it explains state.
- Do keep destructive operations behind explicit review and show actionable errors in both languages.
- Do verify Workspace, History, Diff and Conflict at the review matrix sizes.
- Don't revive the historical third view, bottom workbench or status bar from superseded drawings.
- Don't treat a planned Button/Dialog layer, palette policy or visual phase as already shipped.
