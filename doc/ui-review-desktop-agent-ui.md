# GitCrest UI Review and Improvement Report

Review date: 2026-11-14
Reference: the `desktop-agent-ui` skill (desktop shell, state, input, visual-refinement rules), checked against GitCrest's own `DESIGN.md`.
Status: fixes applied on branch `ui-review-improvements`; in-app verification run on 2026-11-15 (section 7).

---

## 1. Summary

GitCrest's UI is in good structural shape. It has a real token system, flat panels with shadows limited to overlays, IME-safe keyboard handling, correctly split drag/no-drag regions in all three window headers, and a reduced-motion override. Most of the work left is copy and decoration consistency, not architecture.

The highest-value improvements are:

1. **Remove the 3px coloured left-edge bars** on the operation-impact notice, conflict sides and structure-diff rows. Show the meaning with a tint and a text label instead.
2. **Retire the middle-dot separator.** It appears about 78 times across i18n strings and JSX; use layout gaps instead.
3. **Reduce all-caps eyebrow labels.** There are about 60 hard-coded uppercase strings, many of them purely decorative dialog eyebrows.
4. **Fold the six off-token font sizes into the type scale,** and decide whether the 11px floor stays.
5. **Verify in the running Electron window,** where there are four open questions: shadow clipping (`clip-audit.js`), scrollbar jump when dialogs open, long-text overflow and the Windows close-button colour.

Two skill rules conflict with decisions already recorded in `DESIGN.md` (the 11px floor and Git state colours). They are listed in section 5 for an explicit decision, not counted as defects.

---

## 2. Scope and method

| Item | Detail |
|---|---|
| Sources read | `src/styles/globals.css` (2,022 lines), `src/styles/tokens.css`, `src/shared/i18n/**`, feature UI under `src/features/*/ui`, `src/pages/**`, `electron/main/index.ts` (window options), `DESIGN.md` |
| Method | Pattern search plus manual reading of the matching rules and components |
| Authority order | `DESIGN.md` and shipped tokens come first. Skill rules apply where `DESIGN.md` is silent; where the two conflict, the conflict is flagged |
| Not done | Running the app, `clip-audit.js`, screenshots, real-IME testing, macOS/Linux checks |

Counts below come from searching source text. Treat them as close estimates: a few hits are in tooltips, `srOnly` text or `<option>` labels.

---

## 3. What already meets the bar

| Area | Evidence | Skill rule |
|---|---|---|
| Token discipline | Type, radius, spacing and colour go through `tokens.css`; only 5 literal hex values in `globals.css` (4 of them fallbacks inside `var()`) | Anchor to design tokens before changing anything |
| Flat panels | Large `var(--shadow)` is applied only to menus, popovers, dialogs, the command palette, notices and overlay inspectors | Zero shadow on panels |
| Restrained radius | Controls use 4–6px, dialogs 8–9px, all scaled by `--radius-scale` | Restrained corners and shadows |
| IME guard | `isComposing` is checked in `CommitWorkbench.tsx:114`, `:149`, `CommitPanel.tsx:249`, `use-global-shortcuts.ts:70`, `ConflictWindow.tsx:388`, `ConflictEditor.tsx:186`, `shortcut-preferences.ts:83/103` and `zoom-store.ts:69` | Enter during composition must not submit |
| Drag regions | `.titlebar` is `drag`; buttons, nav, tabs, the connection badge and menus are `no-drag` (`globals.css:124–164`). The diff and conflict window headers do the same (`:724`, `:869–870`) | Clickable controls never inside a drag region |
| Native window chrome | `frame: false` on Windows/Linux; `titleBarStyle: "hidden"` with traffic lights on macOS (`electron/main/index.ts:677–680`). The OS draws the window shadow and corners | Leave window shadow and corners to DWM/Quartz |
| Numeric stability | `tabular-nums` declared 21 times | Monospaced digits for changing numbers |
| Focus visibility | 48 `:focus-visible` rules; all 9 `outline: none` uses replace the outline with a ring or background | Keep the native focus contract |
| Reduced motion | `prefers-reduced-motion` plus a user `data-motion` override (`globals.css:1538–1541`) | Degrade motion when the OS asks |
| Real state | Per `DESIGN.md`, operations run as background tasks and report through notices and the Task Center. Whether every progress indicator is driven by task events rather than timers was not checked in this review | State follows real events |
| No status bar, no bottom workbench | Matches the layout rules in `DESIGN.md` | Reduce decision load and noise |

---

## 4. Findings

Severity:
- **P1:** a clear skill violation that is visible in daily use.
- **P2:** a consistency or polish issue.
- **P3:** optional, or only matters for future scope.

### F1 (P1): Coloured left-edge bars

The skill bans this pattern by name ("left colour-bar cards"). GitCrest uses it in two strengths.

**3px bars (fix):**

| Location | Rule |
|---|---|
| `globals.css:697` | `.operationImpactNotice { … border-left: 3px solid var(--amber); … }` combined with a 1px border and a 9px radius, which breaks the closed rounded shape |
| `globals.css:763` | `.conflictSide.ours { box-shadow: inset 3px 0 0 var(--accent); }` |
| `globals.css:764` | `.conflictSide.theirs { box-shadow: inset -3px 0 0 var(--green); }` |
| `globals.css:1650` | `.splitDiffRow-structure { box-shadow: inset 3px 0 var(--accent); }` |
| `globals.css:1651` | `.splitDiffRow-shared { box-shadow: inset 3px 0 var(--amber); }` |
| `globals.css:1654` | `.monacoFileDiff .structureFocusGutter { border-left: 3px solid var(--accent); }` |

**2px selection bars (lower priority):**

`.branchesSidebar .branchItem.selected` (`:517`), `.commitDetailFile.selected` (`:814`), `.splitDiffHunk-active` (`:939`), `.settingsNav button[aria-current]` (`:1317`), `.tagListItem.selected` (`:1696`), `.resolverSelectedRange` (1px, `:1966`).

**Recommendation:**

- **Impact notice:** drop the left bar. Keep the 1px border and add a faint amber tint (`color-mix(in srgb, var(--amber) 8%, var(--surface-raised))`) with a small warning icon next to the first line. The icon gives the meaning a shape, which `DESIGN.md` requires ("colour also needs a label, shape or position").
- **Conflict sides:** the bar is the main ours/theirs cue, so give the cue somewhere else before removing it. Tint the full side (already partly done with `--accent-soft` and `--green-soft`) and make sure the column header text, "Ours" / "Theirs", stays visible.
- **Structure/shared diff rows:** these are gutter markers inside a code view, which is a different context from a card. Keep the marker, but move it into the line-number gutter as a 2px tick or a background tint, so it no longer reads as a card edge.
- **2px selection bars:** these are an established list-selection idiom and are acceptable. If you want full consistency, use the existing `--accent-soft` fill alone. Decide this once for all lists rather than file by file.

### F2 (P1): Middle-dot separators

There are about 78 occurrences in 38 files. The heaviest are `messages/conflicts.ts` (13), `messages/commits.ts` (7), `messages/tasks.ts` (4) and `messages/privacy.ts` (4).

Typical cases:

| Kind | Example |
|---|---|
| Baked into i18n strings | `"bs.detached": "Detached · {oid}"`, `"ai.providerRemote": "{name} · {format} · {model} · {url}"`, `"cf.progress": "{done} of {total} resolved · {left} remaining"`, `"cf.unsaved": "Unsaved edits · Ctrl+S saves"` |
| Built in JSX | `AccountsSection.tsx:277–278`, `BatchRefDialog.tsx:62`, `ConflictWindow.tsx:414`, `PipelineRunList.tsx:95`, `StashList.tsx:98`, `WelcomePage.tsx:97`, `WorkspacePage.tsx:184` |
| Joined in code | `SplitDiff.tsx:263` (`names.join(" · ")`), `LfsPointerNotice.tsx:11`, `ImageDiff.tsx:79` |
| Glyph used as a state icon | `PipelineRunList.tsx:14` (`pending: "·"`) |
| Inside `<option>` text | `RebaseDialog.tsx:158/169`, `ResetDialog.tsx:112/154` |

**Recommendation:**

1. Add one shared component, `MetaList` (`<span class="metaList">` with `display: inline-flex; gap: var(--space-2)`). Use a 1px × 10px `--line-strong` divider as a pseudo-element between items, or no divider at all.
2. Split compound i18n strings into separate keys. For example, `"{name} · {format} · {model} · {url}"` becomes four values rendered through `MetaList`. This also helps translation, because each piece can be reordered.
3. Sentence-style strings should become real sentences instead of dot-joined fragments, for example `"Unsaved edits. Press Ctrl+S to save."` and `"{done} of {total} resolved, {left} left"`.
4. `<option>` text cannot hold layout. There, use an en dash or a space, `main — 1a2b3c4d5`, or show the OID in a second column if the select becomes a listbox.
5. Replace the `pending` glyph with the existing `Icon` component, using a small hollow circle.

### F3 (P1): All-caps eyebrow labels

There are about 60 uppercase strings in i18n, plus CSS `text-transform: uppercase` on `.branchPlacement legend` (`:1080`), `.localFilesPicker legend` (`:1085`), `.themeTokenGroup h4` (`:1459`) and `.commandGroupLabel` (`:1710`). `.sectionEyebrow` (`:212`) uses font-weight 750.

There are three groups, and each needs a different answer:

| Group | Examples | Recommendation |
|---|---|---|
| Decorative dialog eyebrows | `wf.eyebrow` "REVIEW GIT OPERATION", `pull.eyebrow` "REVIEW BEFORE INTEGRATING", `push.eyebrow`, `rs.eyebrow`, `rb.eyebrow`, `tk.eyebrow` "BACKGROUND WORK", `rm.dlgEyebrow`, `welcome.eyebrow`, `settings.eyebrow`, `hist.clearView` | Remove. The dialog title already says what the dialog is. Where the eyebrow carries real context (a repository name or an operation name), move that into the title or subtitle in sentence case |
| Field labels in fact tables | `cd.author`, `cd.parents`, `wf.subject`, `rbd.trackingOid`, `cb.startsAt`, `rs.target` | Use sentence case ("Author", "Starts at") in `--text-muted` at weight 500. This keeps the hierarchy without shouting |
| Group headings | `commandGroupLabel`, `legend` | Sentence case. If uppercase is kept for small group labels, apply it with CSS only and keep the strings in sentence case, so that Chinese and screen readers are unaffected |

Two strings combine an eyebrow with dots and lose the most clarity: `"app.ctxWorkspace": "WORKSPACE · {name}"` and `"cf.fullVersions": "FULL FILE VERSIONS · OURS / BASE / THEIRS"`.

Hard-coded caps in i18n also means screen readers spell some words letter by letter. That is another reason to keep strings in sentence case and leave any casing to CSS.

### F4 (P2): Off-token font sizes and the size count

The declared sizes are:
- **Tokens:** `--type-sm` (198 uses), `--type-xs` (123), `--type-2xs` (47), `--type-md` (7), `--type-lg` (5) and `--type-xl` (2).
- **One-off values:** `calc(14px…)` ×5, `calc(16px…)` ×3, `calc(18px…)` ×2, `calc(19px…)` ×1, and a raw `12px` ×2.

| Line | Rule | Fix |
|---|---|---|
| `:199` | `.searchShortcut > span:first-child` 16px | Icon glyph. Size it with `width`/`height` on the `Icon` component |
| `:273` | `.branchGlyph` 14px | `var(--type-md)` |
| `:649` | `.graphEmpty h2` 14px | `var(--type-md)` |
| `:713` | `.rebaseRollbackPanel h3` 14px | `var(--type-md)` |
| `:726` | `.conflictWindowLabel` raw 12px | `var(--type-xs)`; a raw value ignores `--font-scale` |
| `:1044` | `.paletteSearch > span` 18px | Icon glyph, as with `:199` |
| `:1072` | `.dialogHeading h2` 16px | `var(--type-lg)` |
| `:1178` | `.taskCenterHeader h2` 16px | `var(--type-lg)` |
| `:1312` | `.settingsCloseButton` 19px | Use the shared close `Icon` |
| `:1819` | `.pipelineBanner` raw 12px | `var(--type-xs)`; a raw value ignores `--font-scale` |

The two raw `12px` values are real bugs: they don't follow the user's interface-text-size setting.

Even after this, the app uses six sizes. The skill caps a single view at 4. Most views already use only `xs`, `sm` and `md`; `lg` and `xl` appear on dialog titles, the Welcome page and Settings. That is acceptable per view, but worth checking screen by screen.

### F5 (P2): Undeclared fallback colours and the Windows close button

| Line | Issue |
|---|---|
| `:133` | `.windowClose:hover { background: #c42b1c; color: #fff; }` |
| `:619` | `var(--warning, #d29922)` |
| `:1787–1788` | `var(--success, #2da44e)`, `var(--danger, #cf222e)` |
| `:1819` | `var(--surface-2, var(--surface))` |

The `#c42b1c` value at `:133` matches Windows 11's native close-button red, which is intentional and correct for platform fidelity. Keep it, but name it as a token (`--window-close-hover`) so theme authors know it is fixed on purpose.

The other fallbacks reference tokens that do exist, so the hex values are dead code that could drift from the palette. Drop the fallbacks. `--success` and `--surface-2` are not in the `DESIGN.md` role table; standardise on `--green` and `--surface-soft`, or document the aliases.

### F6 (P2): No `scrollbar-gutter: stable`

No scroll container declares a stable gutter. When a dialog opens and a background scroller loses its scrollbar, content can shift sideways by the scrollbar width. Windows uses classic scrollbars, so this is most visible there.

**Recommendation:** add `scrollbar-gutter: stable` to the long-lived vertical scrollers: the change tree, the history list, the branch list, the settings page body and the Task Center list. Confirm the jump first in the running app, because some scrollers may already use overlay scrollbars.

### F7 (P2): No `text-wrap: balance` on headings

There is no `text-wrap` anywhere. Dialog titles (`.dialogHeading h2`), empty-state headings (`.graphEmpty h2`) and Welcome headings can end with a single orphan word, especially in Chinese at narrow widths.

**Recommendation:**

```css
.dialogHeading h2, .taskCenterHeader h2, .graphEmpty h2, .welcomeHero h1 { text-wrap: balance; }
.emptyState p, .inlineHint { text-wrap: pretty; }
```

### F8 (P2): Helper and description text density

Many dialogs pair an eyebrow, a title, a help paragraph (`.cloneHelp`, used for most dialog helper text) and field hints. Combined with F3, a typical workflow dialog has four layers of text before the first control.

**Recommendation:** for each dialog, keep the title plus one optional sentence that states the impact. Move the rest to an `InlineHint` that appears on focus or on error. The good examples to copy are the existing `operationImpactNotice` content, which states real consequences, and `DiffStatusNotice`.

This needs a screen-by-screen pass rather than a search, so it is listed here as a follow-up rather than with exact lines.

### F9 (P2): Commit description growth

`.commitDescription` (`:436`) has `min-height: 64px; max-height: 240px; resize: vertical`. Manual resize is fine for a Git workbench. Two small refinements:

- Add `field-sizing: content` (Chromium in Electron supports it), so the field grows with typing up to the 240px cap and the drag handle becomes optional.
- Check that the summary field's Enter-to-commit path (`CommitPanel.tsx:249`) and the description's Ctrl+Enter path both use the same composition guard. They do today; keep a test that covers it, because a regression there would commit half-typed Chinese.

### F10 (P3): Hairline borders

All dividers are 1px. The skill prefers 0.5px. `DESIGN.md:70` explicitly specifies "1px dividers", and on 100% Windows scaling a 0.5px border either rounds to 1px or disappears. **Recommendation:** no change.

### F11 (P3): RTL and long translations

There are no `dir` attributes and no logical properties for inline direction, and the app ships English and Chinese only. No action is needed now.

If more locales are planned:
- Switch `left/right` paddings to `padding-inline-*` in the shell first.
- Keep diffs, SHAs, paths, shortcuts and the commit graph `dir="ltr"`.
- Audit fixed-width controls. For example, `.settingsCloseButton { width: 32px }` is fine because it is an icon, but text buttons must not get fixed widths.

### F12 (P3): Dark-mode weight compensation

The skill suggests lowering weights one step in dark mode. GitCrest uses fine-grained weights (560, 620, 650, 750) and a variable-font stack. **Recommendation:** optional. If you try it, do it with a single token (for example `--weight-strong: 620` in light and `580` in dark) rather than per rule, and compare screenshots before keeping it.

---

## 5. Conflicts with `DESIGN.md`: decisions needed

| Topic | Skill rule | `DESIGN.md` | Recommendation |
|---|---|---|---|
| Minimum text size | 12px hard floor | 11px floor for `--type-2xs` (`DESIGN.md:52`), used 47 times (badges, counts, file directories, the graph empty-state eyebrow) | **Raise to 12px**, a one-line change in `tokens.css:5`. Then check badge heights (`.viewTabCount` 17px, `.changeTreeGroupCount` 18px) and dense rows at compact density. 11px text on 100% Windows scaling is where readability suffers most |
| Single accent colour | One accent; everything else neutral grey | Git state colours and optional graph-lane colours are deliberate orientation cues | **Keep `DESIGN.md`.** In a Git client these colours carry meaning, and graph colouring is already opt-in. Apply the single-accent rule to *actions* only: secondary buttons and icons stay neutral, which they already do |
| Hairline borders | 0.5px | 1px dividers | **Keep 1px** (see F10) |

---

## 6. Improvement plan

### Phase 1: quick fixes (CSS and tokens, low risk)

> Status (2026-11-15): all five items are applied. Item 5 was accepted: `--type-xs` is now `max(12px, 12px × scale)` and `--type-2xs` is an alias of it. Without the `max()`, the smallest interface text setting (12px) would scale `--type-xs` down to about 11.1px. The e2e readability floor (`tests/e2e/readability.ts`) and `DESIGN.md` now say 12px. Code size keeps its own 11–20px range. Notes:
> - The icon wrappers (`.searchShortcut`, `.paletteSearch`, `.branchGlyph`) had a font-size that did nothing, since `.gcIcon` is a fixed 16px. The font-size was removed and the wrappers became `inline-flex`.
> - `.settingsCloseButton` was dead CSS with no users, so it was removed.
> - The impact notice now uses an amber tint, an amber-mixed border and a new `warning` icon in its heading.
> - Verified with `pnpm frontend:boundaries`, `pnpm build` and `pnpm test` (868 passed). Not yet checked visually in the Electron window.

1. Replace the six one-off font sizes, including the two raw `12px` values (F4).
2. Remove the dead hex fallbacks and name the Windows close red as a token (F5).
3. Add `text-wrap: balance` / `pretty` (F7).
4. Restyle `.operationImpactNotice` without the left bar (F1).
5. Decide on the 11px → 12px floor and apply it if accepted (section 5).

### Phase 2: copy cleanup (i18n plus a few components)

1. Add the `MetaList` component and its `.metaList` style (F2).
2. Rewrite the dot-joined strings in both `en` and `zh`. Start with `conflicts.ts`, `commits.ts`, `tasks.ts` and `privacy.ts`, which cover about a third of the occurrences (F2).
3. Remove decorative eyebrows and convert field labels to sentence case (F3).
4. Run `pnpm test` and `pnpm test:e2e`, since some tests likely assert on these strings.

### Phase 3: interaction details (needs the running app)

1. Rework the conflict-side cues (F1) together with the conflict resolver UI guide in `doc/conflict-resolver-uiux-implementation-guide.md`.
2. Add `scrollbar-gutter: stable` where a jump is confirmed (F6).
3. Add `field-sizing: content` to the commit description (F9).
4. Do the dialog helper-text density pass (F8).

### Phase 4: verification gate (see section 7)

Run this after phases 1–3, in the packaged or dev Electron window and not the Vite web preview.

### Implementation log (branch `ui-review-improvements`)

| Commit | Finding | What changed |
|---|---|---|
| `style: align type sizes, colour tokens and impact notice…` | F1 (impact notice), F4, F5, F7, §5 floor | Phase 1 plus the 12px floor |
| `refactor(ui): replace middle-dot separators in components with MetaList` | F2 | New `MetaList` component and `.metaList` style; 24 components updated |
| `copy: rewrite dot-joined strings as punctuated text in both languages` | F2 | 29 keys rewritten in English and Chinese |
| `test(e2e): follow the separator and copy changes` | F2 | E2e text assertions updated |
| `copy: drop eyebrow labels and use sentence case for field labels` | F3 | 35 unused keys removed; visible labels changed to sentence case; CSS uppercase removed |
| `style(diff): replace coloured edge bars on conflict sides and structure rows` | F1 | Conflict sides keep their tint only; structure rows tint the line-number gutter |
| `style: keep a stable scrollbar gutter on long-lived lists` | F6 | `scrollbar-gutter: stable` on 14 list scrollers |
| `style(commits): grow the commit description with its content` | F9 | `field-sizing: content` with a 4-line minimum |
| `style: remove unused CSS rules and font sizes that had no effect` | F4 follow-up | 66 rules for classes nothing renders removed; the pipeline runs heading's fixed 13px became `--type-sm` |
| `refactor(ui): replace text glyphs used as icons with the Icon component` | F2 item 5 | Pipeline step marks, notice kinds, conflict gutter arrows and the empty commit-details mark now use `Icon` (new `commit`, `circle`, `minus`, `error`) |
| `copy(electron): use an em dash in diff and conflict window titles` | F2 | Native window titles no longer use the middle dot |
| `fix(history): show the advanced filters above the graph and style their fields` | §7 | Found by the in-app check: the popover was painted under the graph rows and its fields were unstyled. Count pills now grow with the text size |

Where the work differed from the plan:

- **F3:** almost all dialog eyebrow keys were already unused. The dialogs had dropped them, but the strings were still in i18n. The only visible eyebrow was the history empty state. The finding overstated how often eyebrows appear on screen. The real work was removing dead keys and changing about 40 field labels to sentence case.
- **F2:** the core's pipeline worktree label (`"{target} · pipeline worktree"`, built in `crates/gitcrest-core/src/features/pipelines/service.rs`) was left unchanged. The conflict window matches it as data, so changing it means changing the core and the frontend together.
- **F1:**
  - The Monaco `structureFocusGutter` decoration was kept. It already sits in the editor's decoration lane, which is the standard place for line markers.
  - The 2px selection bars on list rows were kept as the list-selection idiom (one decision for all lists).
- **Not done:** F8 (dialog helper-text density) needs a screen-by-screen review in the running app. F10–F12 stay as recommended: no change.

---

## 7. Verification checklist

| Check | How | Pass condition |
|---|---|---|
| Shadow clipping | Paste `~/.claude/skills/desktop-agent-ui/scripts/clip-audit.js` into DevTools and run it with `{ viewport: true }` in four states: resting, hover, open popover/menu, and inspector overlay at a narrow width | `cut === 0` in every state; review the `hidden` list by hand |
| Popovers near edges | Open `.historyAdvancedFilters`, `.commitActionMenu` and `.fileDiffOptionsBody` next to window edges and inside scrolled panels | No half-cut shadow; nothing clipped by an `overflow: hidden` ancestor (141 overflow rules exist, so this is a real risk) |
| Dialog scroll jump | Open and close the Clone, Branch switcher and Task Center dialogs over a scrolled history list on Windows | No horizontal shift |
| IME | Type Chinese with Microsoft Pinyin in the commit summary, description, branch filter and command palette, and press Enter to pick a candidate | No commit, submit or navigation fires during composition |
| Drag regions | Click every titlebar control and tab; try to drag the window from empty titlebar space and from the diff/conflict window headers | Controls never drag the window; empty space always does |
| Font scale | Set the interface text size to its smallest and largest values | No raw-px text stays fixed; badges do not clip |
| Long text | Very long branch names, remote URLs and repository names in tabs, the toolbar, the branch picker and dialogs | Ellipsis or wrap, with no overflow or button overlap |
| Themes | Light, dark and one custom theme | No literal colour remains visible outside the close button |
| Reduced motion | OS reduced motion on; app setting off and on | Transitions are effectively instant when reduced |

Record the environment for each run (Windows 11 build, Electron version), with screenshots of each state and the `clip-audit.js` output, alongside the existing records under `doc/evidence/`.

### Results (2026-11-15)

Environment: Windows 11 (10.0.26300), Electron 37.0.0 (Chromium 138), built app driven by Playwright with the review fixture, at 1280×800 and 960×700, 100% scale.

| Check | Result |
|---|---|
| Shadow clipping | Pass, with three known cuts that were reviewed by eye. `.historyAdvancedFilters` loses the outer 44px of its blur on the right, at the edge of `.viewMain`. `.fileDiffOptionsBody` loses about 4px at the top, under the diff toolbar. `.worktreeSwitcherMenu` loses its left blur at the window edge (it is `position: fixed`, so the audit's `overflow` attribution is wrong). None is visible in screenshots, because `--shadow` is a 56px blur at 18–32% alpha |
| Popovers near edges | **Failed, then fixed.** The advanced-filters popover was painted under the commit graph rows (both layers were at `z-index: 1`) and its fields had no styling |
| Dialog scroll jump | Pass. Opening the palette, branch switcher and Task Center over a scrolled history list shifts the rows by 0px (`scrollbar-gutter: stable`) |
| IME | Not run. This needs a real Microsoft Pinyin session; the unit tests cover the `isComposing` guards |
| Drag regions | Pass. `.titlebar` is the only drag area in the main window, and none of the 59 visible interactive elements resolve to `drag`. The diff and conflict window headers were not checked |
| Font scale | Pass at 12px (smallest text 12px). **Failed, then fixed** at 16px: `.viewTabCount` and `.changeTreeGroupCount` clipped their digits |
| Long text | Pass. A 104-character branch name ends in an ellipsis in the toolbar, branch list and worktree menu; no toolbar overlap; no page-level horizontal scroll |
| Themes | Pass for light and dark (screenshots reviewed). A custom theme was not checked |
| Reduced motion | Pass. The OS setting and the app override both resolve transitions to effectively 0s, and `full` overrides the OS |

Seen in screenshots, not fixed here:

- In the commit graph, lane edges cross the subject text of rows whose own lane sits left of an active lane (for example "Merge release notes" in the review fixture). The subject indent appears to follow the row's own lane rather than the widest active lane; not yet confirmed in code.
- `ConflictBlockRow` and its `.conflictGutter` / `.conflictMergeRow` styles are not imported anywhere since the Monaco resolver replaced them.

---

## Appendix A: Middle-dot occurrences by file

| File | Count |
|---|---|
| `src/shared/i18n/messages/conflicts.ts` | 13 |
| `src/shared/i18n/messages/commits.ts` | 7 |
| `src/shared/i18n/messages/tasks.ts` | 4 |
| `src/shared/i18n/messages/privacy.ts` | 4 |
| `src/pages/workspace/WorkspacePage.tsx` | 3 |
| `src/features/pipelines/ui/AutomationsSection.tsx` | 3 |
| `src/shared/i18n/en.ts`, `zh.ts` | 2 each |
| `src/shared/i18n/messages/app.ts`, `branches3.ts` | 2 each |
| `src/pages/welcome/WelcomePage.tsx` | 2 |
| `src/features/workflows/ui/ResetDialog.tsx`, `RebaseDialog.tsx` | 2 each |
| `src/features/workflows/model/use-open-conflict-window.ts` | 2 |
| `src/features/pipelines/ui/PipelineRunList.tsx` | 2 |
| `src/features/diff/ui/SplitDiff.tsx`, `DiffWindow.tsx` | 2 each |
| `src/features/accounts/ui/AccountsSection.tsx` | 2 |
| 18 further files | 1 each |

## Appendix B: Uppercase i18n keys

- **Eyebrows to remove or rework:** `welcome.eyebrow`, `settings.eyebrow`, `app.ctxWelcome`, `app.ctxWorkspace`, `app.ctxNoRepo`, `lb.eyebrow`, `nw.eyebrow`, `rw.eyebrow`, `cb.eyebrow`, `cb.worktreeEyebrow`, `rbd.eyebrow`, `bs.eyebrow`, `compare.eyebrow`, `cf.eyebrow`, `reflog.eyebrow`, `hist.clearView`, `pull.eyebrow`, `push.eyebrow`, `clone.eyebrow`, `rm.dlgEyebrow`, `sm.eyebrow`, `tk.eyebrow`, `sh.composerEyebrow`, `sh.deleteEyebrow`, `wf.eyebrow`, `rs.eyebrow`, `rb.eyebrow`.
- **Field labels to change to sentence case:** `lb.branch`, `nw.branch`, `nw.remoteBranch`, `rw.folder`, `rw.branch`, `cb.startsAt`, `rbd.targetRef`, `rbd.remoteBranch`, `rbd.trackingOid`, `rbd.commitsOnlyThere`, `rbd.filesDiffer`, `cf.workflow`, `cf.colResult`, `cf.colTheirs`, `cf.fullVersions`, `cf.stageTheirs`, `cf.resultPreview`, `cf.editResult`, `cs.currentResult`, `dc.repository`, `dc.selected`, `cd.commit`, `cd.author`, `cd.parents`, `rm.default`, `wf.targetBranch`, `wf.targetCommit`, `wf.subject`, `rs.branch`, `rs.commits`, `rs.target`, `rb.branch`, `rb.commits`.
