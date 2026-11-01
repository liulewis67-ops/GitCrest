# Conflict Resolver UI/UX Implementation Guide

Status: implemented in the current worktree under the resumed optimization goal, then refined to a clean result and source arrows. See [current validation evidence](evidence/conflict-resolver-clean-result-validation.md) and the [baseline record](evidence/conflict-resolver-uiux-validation.md).

Date: 2026-11-01

Scope: all five findings from the conflict-window critique. Selected layout: editable result between the two sources. Visitor mode: Operate. Preserve GitCrest's established quiet, neutral visual system.

## 1. Outcome and boundaries

A user should understand which file and conflict needs attention, compare both sources, edit the real output, and save/resolve without searching elsewhere in the window. Completing the last file should provide a direct route to the existing Task Center operation.

This document is the implementation target for the new presentation and interaction behavior. `DESIGN.md` remains the authority for shared tokens and components. `doc/conflict-resolver-enhancement-plan.md` describes earlier merge capabilities; retain those capabilities, but this guide supersedes its row-based result-preview layout. Do not implement its historical layout as a second mode.

In scope:

- A single editable result between read-only current and incoming sources.
- Persistent file status and completion controls.
- Clear separation of conflict actions and whole-file actions.
- Consistent replacement protection, keyboard continuity, and completion handoff.
- Contrast, localization, constrained-window behavior, and relevant error states.

Outside scope: changing merge algorithms, adding automatic Git continuation, redesigning the main workbench, expanding AI provider functionality, changing binary-resolution semantics, or increasing the conflict window's core API privileges. No product claims, new visual identity, or backend merge engine changes are required.

## 2. Evidence and priorities

The critique used the current rendered build at 960×700 in light and dark themes, source review, keyboard interaction, and independent source/live detector assessments. Wider-window behavior and final operation continuation were not exercised in that run.

| Finding | Priority | Required outcome |
|---|---|---|
| Collapsed preview occupies 190px; save footer begins around y932 at 960×700 | P1 | No blank collapsed panel; completion controls remain visible |
| Base/candidate preview, result preview, and draft compete | P2 | Exactly one authoritative editable result |
| Local and whole-file action scopes compete | P2 | Current-conflict decisions lead; file operations are secondary |
| Accepting a focused block leaves focus on BODY | P2 | Predictable focus on the next conflict or result |
| Completion copy requires manual return to Task Center | P2 | Direct, acknowledged handoff to the existing task |

Related quality fixes: light-theme source line numbers measured 3.6:1 and the enabled Mark resolved button 4.3:1. Use readable semantic text colors and `--on-accent`; verify both themes and custom appearance settings. Font-prevalence detector output is not a reason to change the established typography.

## 3. Window structure

```text
Resolve conflicts · operation                 2 files remaining   window controls
--------------------------------------------------------------------------------
Files          | conflict-one.txt · 1 conflict remaining
               | Previous / Next · Conflict 1 of 2       Undo / Redo  File actions
               |---------------------------------------------------------------
selected file  | Current version    | Result · Unsaved       | Incoming version
other files    | read-only          | EDITABLE WORKING DRAFT | read-only
               | source text        | full file text         | source text
               |                   |                        |
               |       Current-conflict actions and optional suggestion details
--------------------------------------------------------------------------------
Status / recoverable error          Save draft         Save & mark resolved
```

The sketch shows hierarchy rather than pixel dimensions. Use existing spacing, type, corner, button, focus, and color tokens.

### Layout contract

- Bound the window to the available viewport height. Header and footer stay outside the scrolling work area. Avoid document-level scrolling during normal text resolution.
- Let the file list and editors scroll within their assigned areas. Menus/dialogs must not be clipped by those scroll containers.
- At 1280×816, show the file list and all three panes. Give the result more width than either source; start with a 30/40/30 split of the editor area, adjustable through shared accessible separators.
- At 960×700, keep all three panes and the footer visible. Collapse the file list into a labeled Files control with remaining count; opening it temporarily overlays the workspace. Do not force a permanent 25% sidebar at this size.
- Use available width rather than device identity for the sidebar breakpoint; 1100 CSS px is the initial implementation threshold, subject to the acceptance matrix below.
- Below 860 CSS px or at enlarged UI scale, use Result with one selectable source pane, labeled Current / Incoming. Preserve the same result model, caret, undo history, and selected conflict. Offer a way to show both sources when space permits. Do not compress three unusably narrow columns.
- On short windows, the editor area shrinks and scrolls internally; header/footer controls wrap without covering content. At 200% zoom, navigation and save actions remain reachable without horizontal page scrolling.
- Each pane has its own horizontal scrolling. Vertical navigation should align corresponding conflict ranges when selecting a conflict; free scrolling must remain independent. Do not synchronize raw scrollTop values across files with different line counts.
- Remember user pane ratios within the resolver presentation preference, clamp them on resize, and keep sensible minimum widths. Pane resizing must not alter file content or dirty state.

## 4. One authoritative result

Updated interaction requirement: the center shows a clean, editable full-file result without Git's `<<<<<<<`, `=======` and `>>>>>>>` marker blocks. Pending decisions are tracked separately from the visible text. For each unresolved region, use the ancestor as its starting content, or the current-side content as a pending proposal if the ancestor cannot be mapped. Highlight these regions so a clean display is never mistaken for completed resolution.

Render merge arrows beside the corresponding source changes. Arrows point into the result, apply only that pending conflict and disappear after acceptance; Undo restores the pending decision and arrows. Arrows are ordinary keyboard-accessible controls. A manually composed edit intersecting a highlighted region resolves that region using the exact edited output, allowing both sides' changes to be combined within one line. Context-only edits leave other decisions pending. Keep secondary selected-conflict controls where source mapping is unavailable.

The internal draft may retain Git markers for unresolved decisions so the existing Save draft/reopen API preserves them. They are projected out of the editor; once all decisions are resolved, the visible text and saved content are identical. Tie pending-decision snapshots to the editor's undo versions so history restores text and decision status together, including acceptance that leaves visible text unchanged.

Remove the separate center base-preview cells, standalone Result Preview disclosure, and bottom duplicate result editor. Full ancestor inspection remains secondary; the ancestor used as the editable starting point is still an unresolved result region. A Smart Merge candidate is explicitly labeled Suggested merge and stays separate until applied.

Use the existing Monaco dependency for the editable result and read-only source panes, following the app's editor/theme lifecycle conventions. Reuse existing infrastructure where suitable; do not add another editor package. The required behavior is the single-result contract, not a dependency on a particular wrapper API.

Editor requirements:

- Current and incoming source contents are immutable; result is editable and has visible focus.
- Full-file context stays available after accepting a conflict. Applying a choice replaces only that conflict's marked range in the result; the chosen text remains visible.
- Conflict decorations identify unresolved ranges. Selected conflict has a distinct outline/marker in addition to color. Keep the source identities labeled in narrow layouts and for screen readers.
- Preserve line endings and final-newline behavior through load, edit, replacement, undo, and save. Never silently reformat or normalize the entire file when the editor mounts.
- Give each pane an accessible name. Provide a keyboard-accessible conflict list or navigation control; decorations alone are insufficient.
- Dispose editor models/listeners on file change or window close; give each model a unique repository/task/path identity. No stale model content may leak between files or windows.

The existing review suggested adding actual branch names, but current file responses do not guarantee that metadata. Use Current version and Incoming version, with existing operation context. Display verified branch names only when supplied by a reliable existing source; do not invent them or promise them in this scope.

## 5. Conflict navigation and actions

The main toolbar contains previous/next conflict, position/remaining count, undo/redo, and File actions. Remove the permanent non-conflicting and whole-file replacement button groups.

For the selected conflict expose three primary choices: Use current, Use incoming, and Accept both. Accept both keeps current then incoming ordering, matching the existing algorithm. State that ordering in its accessible description/tooltip.

- Keep Ignore current / Ignore incoming as secondary conflict actions. Preserve current semantics, including keeping the base when both sides are ignored, but explicitly label that consequence. If base is unavailable and the current algorithm produces empty text, describe that consequence before application; do not misleadingly promise restoration of a base.
- Show Smart Merge as an available secondary action only when the existing model produces a safe candidate. If unavailable, provide a brief contextual explanation in the conflict details rather than a prominent disabled action bar.
- A local action applies to the selected unresolved block only. A file action always names its whole-file scope.
- After application, recalculate unresolved ranges from the actual draft and announce the remaining count. Do not count a hidden/ignored choice as saved or staged.
- Keep existing Alt+1/2/3/4 choices, Alt+Up/Down navigation, and Mod+S. Display actual supported shortcuts in tooltips/help. Ensure shortcuts do not interfere with editor composition, AltGr, or native text-editing commands. Use key codes consistently for supported digit shortcuts.

### Range and identity safety

The current parser's IDs depend on positions/content and may change after editing. Do not rely on those IDs as permanent editor anchors. Derive navigation from current model ranges after each transaction. Map source ranges using the existing three-way regions only where correspondence is known; otherwise show the whole source with an honest unavailable-mapping state. Never manufacture source line numbers from result offsets.

When replacing a conflict, validate that its current range/text still matches the selected block. If typing changed it, recompute selection before applying; never replace a stale offset. While conflict analysis is pending or incomplete, prevent block actions using stale mappings. Preserve editing and allow Save draft.

If manual edits leave malformed or incomplete markers, show a visible review warning and disable completion until analysis can establish a marker-free result. Do not report “all resolved” merely because a parser failed to recognize an incomplete block. Keep any existing backend marker validation authoritative as an additional guard.

## 6. File actions and replacement safety

File actions groups these existing capabilities:

1. Apply non-conflicting changes: both sides, current only, incoming only.
2. Replace result with entire current / entire incoming version.
3. Smart Merge all eligible conflicts, with eligible count.
4. AI merge and source/base inspection.

Unavailable choices carry a focusable explanation through the shared menu conventions. Group full-file replacement separately from additive/local choices.

Any operation replacing/rebuilding a whole dirty draft uses the same confirmation: identify the file and scope, explain that unsaved result edits will be replaced, and offer Keep edits / Replace result. Initial focus is Keep edits. Cancel preserves selection, caret, scroll and draft. Apply replacement as one undoable edit. A pristine draft does not need an extra confirmation.

AI merge retains existing endpoint/source review and consent behavior. A proposed response is not the result until explicitly accepted; acceptance creates an unsaved, undoable result transaction. Retain the current save-first requirement and stale-revision checks rather than silently sending unsaved content. Present the AI UI in a secondary panel/dialog that does not permanently displace completion controls.

## 7. Save and completion state machine

Use explicit predicates from current file state, analysis validity, dirty state, and active operation. File saving and staging remain separate backend operations even when one UI action sequences them.

| State | Footer behavior | File navigation |
|---|---|---|
| Loading / no file | Loading or empty guidance; no mutation actions | Available only where safe |
| Unresolved, unchanged | Remaining count; Save disabled; completion disabled with reason | Allowed |
| Unresolved, dirty | Save draft enabled; completion disabled with reason | Retain existing save-before-switch protection |
| Marker-free, dirty | Save draft secondary; Save & mark resolved primary | Save-before-switch protection |
| Marker-free, saved | Mark resolved primary; Save disabled | Allowed |
| Analysis invalid/pending | Visible reason; Save draft allowed when dirty; completion disabled | Protect unsaved edits |
| Saving / staging | Named busy state; prevent duplicate mutations | Disabled |
| Save/stage failure | Error and retry near footer; keep draft and recovery context | Restore safe controls |
| All files resolved | Dedicated completion content; Return to Task Center primary | No stale file/editor |

- Saving a draft containing unresolved markers is allowed and does not resolve the file.
- Save & mark resolved must await confirmed save, then stage using the newly returned/confirmed revision. Save failure prevents staging. Stage failure after successful save leaves a saved result with a retryable Mark resolved action.
- Do not optimistically remove a file or declare completion until the existing task/preflight flow confirms it.
- Current operation, HEAD, and result-revision guards remain in force. External changes produce recovery guidance; do not blindly overwrite or silently reload over dirty edits.
- Preserve existing restart/reconnect draft carrying and before-close protection. Closing or switching must never silently discard unsaved work.
- Binary and delete/modify conflicts retain explicit side/deletion choices with accurate labels. They use the persistent footer/completion feedback where applicable; do not mount a misleading text editor for absent/binary content.

## 8. Focus and undo contracts

### Focus

- Initial text-file focus goes to the result at the first unresolved conflict, without applying a choice.
- After accepting a conflict, select the next unresolved range at/after its prior location, wrapping once if necessary. Move actual keyboard focus to its result location, not just scroll.
- After the final block, retain focus in the result around the accepted text and announce that review/save is available. Avoid unexpectedly focusing a mutation button while the user is repeatedly pressing Enter.
- After confirmed file resolution, focus the next file's result. After the last file, focus the completion heading with a clear Return to Task Center action next in Tab order.
- Menus, disclosures, confirmations and AI panels restore focus to their trigger; if it no longer exists, use the result editor or completion heading.
- Use polite, concise live announcements for conflict counts/save outcomes. Keep errors assertive and avoid announcing every keystroke or every diff decoration.

### Undo

Adopt one coherent editor undo stack for manual typing and programmatic draft changes. Do not retain a parallel `useDraftHistory` stack that competes with Monaco's typing history. Wrap each accept, replace, Smart Merge or AI-accept action in an intentional edit transaction with undo boundaries; preserve ordinary typing grouping. Undo/Redo toolbar state and shortcuts must reflect this same stack, regardless of focus.

Saving does not clear undo history; dirty state compares exact current content with the last confirmed saved text. Undo after saving may make the draft dirty again. File changes create/reset the correct file history according to the existing save-before-switch policy. Source panes must never accept edits through global undo routing.

## 9. Task Center handoff

There is currently no Task Center handoff method on `GitCrestBridge`; text-only guidance is not sufficient. Add a narrow desktop IPC path rather than granting the conflict renderer read-write core access.

Suggested contract: `returnToTaskCenter(): Promise<{ ok: true } | { ok: false; reason: string }>` on conflict-window preload, plus a main-renderer subscription for the destination request. Naming may follow existing bridge conventions; behavior is required:

1. Main process derives repo/task identity from the requesting window's registered conflict context. Do not trust renderer-provided arbitrary targets or channels.
2. Validate the sender as that conflict window. Keep its sidecar token/capability restricted to conflict resolution.
3. Restore/focus the existing main window, open Task Center and reveal/focus the matching task. If the main window must be recreated, register/deliver the request after its listener is ready.
4. Require an acknowledgement that Task Center handled the navigation. Resolve success only after acknowledgement; avoid dropping requests during renderer startup. Use a correlation ID and bounded timeout.
5. If the task has completed/disappeared, show the task list with a clear updated-state message. If main-window navigation fails, leave the resolver open with a retryable error.
6. Do not continue, skip, abort, commit, or otherwise mutate the Git workflow through this action. Task Center retains its existing explicit operation controls.

Leave the resolver open after successful handoff; do not auto-close or auto-run Git continuation. Its completion state remains safe to return to. If conflicts reappear after refresh/reconnect, replace completion with the current conflict list.

## 10. Visual, accessibility and localization requirements

- Retain semantic tokens and the existing UI/code font stacks. Use a single accent for selected conflict/primary completion; source tints remain quiet and labeled.
- Use shared Button, MenuButton/ContextMenu, Dialog, ResizeSeparator, ErrorMessage, Icon and window controls where their APIs fit. Keep ordinary desktop controls at shared compact/regular sizes rather than bespoke 24–26px targets.
- Use `--on-accent` for filled primary-button text. Verify small line numbers/status text at 4.5:1 against their actual tinted backgrounds; do not solve contrast by increasing opacity of an entire pane.
- Status, selection, source identity and changes must not rely on color alone. Keyboard focus remains visible in both editor and surrounding controls.
- Base/full-source disclosures occupy only their summary height while closed. No placeholder panel with a minimum height remains in the normal layout.
- Respect reduced motion. Conflict jumps should be immediate or reduced-motion aware.
- Add all new labels, reasons and announcements to English and Chinese message catalogs. Avoid concatenating translated fragments. Test long paths, CJK content and increased font scale.
- Do not promise complete screen-reader parity from editor integration alone; validate reading, conflict navigation, editing, choices and saving with accessible names and actual keyboard traversal.

## 11. Development map and sequence

| Area | Existing files / likely work |
|---|---|
| Window orchestration | `src/features/workflows/ui/ConflictWindow.tsx`: simplify layout, preserve API/recovery flow |
| Comparison UI | Replace `ConflictBlockRow.tsx` presentation with pane workspace and selected-conflict actions; reuse `ConflictSideLines.tsx` where useful for candidate/base inspection |
| Merge/range model | Existing `conflict-blocks.ts`, `merge3.ts`, `smart-merge.ts`; add range adaptation only where needed, preserve algorithm semantics |
| Result editor | Small local component owning editor models, transactions, selection/focus and lifecycle; no second draft state |
| History | Migrate resolver off `use-draft-history.ts` only after unified undo behavior is verified; do not remove unrelated consumers |
| AI | `ConflictSuggestionPanel.tsx`: preserve consent/revision checks; adapt placement/result acceptance |
| Styling/copy | Scoped resolver rules in `src/styles/globals.css`; `src/shared/i18n/messages/conflicts.ts`; shared tokens |
| Handoff | `src/api/bridge.ts`, `electron/preload/index.ts`, `electron/main/index.ts`, main app connection/Task Center controller; align duplicated bridge types |
| Verification | Existing conflict unit/E2E suites and owned review fixtures/screenshots |

Implementation slices:

1. Establish bounded shell, persistent footer, file-list collapse, and the single center draft editor. Preserve existing saving and conflict parsing.
2. Connect read-only source panes, conflict range navigation, acceptance transactions, retained result context, and unified undo/focus. Prove stale-range safety before enabling all local actions.
3. Move file operations into the secondary menu; unify replacement confirmation; adapt Smart Merge/base/AI presentation.
4. Apply the explicit completion state machine and revision-safe save-then-stage behavior, including binary/deletion states.
5. Add the constrained Task Center IPC handoff and acknowledgement/failure behavior.
6. Run targeted behavioral checks and visual/accessibility verification; fix contrast and localized layouts; update durable design documentation to reflect shipped behavior only after implementation.

Each slice should leave a usable resolver. Do not ship an intermediate layout containing both the new center result and the old duplicate editor.

## 12. Acceptance and validation

### Required behavioral scenarios

- Resolve a multi-block file with current/incoming/both choices. Only the chosen range changes; full-file surrounding content and chosen output remain visible.
- Type manually, apply a block choice, undo/redo both actions in order, save, then undo. Content and dirty state remain correct.
- Edit while a conflict action is pending/recomputed. A stale range never replaces unrelated text.
- Test inserted/deleted lines, absent base, CRLF, final newline, identical repeated blocks, long lines, malformed markers and empty text files.
- Try each dirty whole-file replacement and cancel/confirm it. Cancel preserves everything; confirm is one undoable transaction.
- Save with markers; completion remains unavailable. Remove markers, save and stage; file removal waits for confirmation.
- Inject save failure, staging failure after save, external revision change and core restart. No silent draft loss or false completion occurs.
- Keyboard-resolve successive conflicts and successive files. Focus never falls to BODY; Tab can reach every primary action and return from menus/dialogs.
- Resolve the final file, return to Task Center, and verify the exact task is revealed with no Git continuation executed. Exercise missing task, missing/recreated main window, delayed listener and acknowledgement timeout.
- Validate binary and delete/modify flows, including explicit deletion labels and failures.
- AI acceptance stays explicit, undoable and unsaved; stale proposals remain rejected.
- Large supported files remain editable and navigable; expensive analysis is bounded/deferred, reports its pending/fallback state and never corrupts the draft. Reuse current limits rather than raising them silently.

### Visual and accessibility matrix

Capture light/dark × English/Chinese at 1280×816 and 960×700. Include a populated multi-file case, multiple conflicts, marker-free dirty result, completion, recoverable error and replacement confirmation. Also inspect below-860 layout and 200% zoom.

Pass conditions:

- Footer is visible initially and after navigation; no document scrolling is required to reach save/completion at the two baseline sizes.
- The center pane displays the clean working result. Unresolved ancestor/current starting regions are visibly pending, never falsely counted as accepted; no Git marker blocks appear from loaded conflicts.
- Both sources and result are usable at baseline widths; narrow fallback preserves content, caret and undo.
- No closed disclosure leaves an empty panel; labels/actions do not overlap or truncate their meaning.
- New file/Task Center transitions preserve meaningful focus and provide concise status feedback.
- Contrast targets pass against real rendered backgrounds; menus/separators/editor controls are keyboard usable.

Run relevant existing and added conflict tests, TypeScript checks and frontend boundary checks. Add meaningful IPC/handoff coverage for sender validation and acknowledgement races. Build the renderer before owned Electron visual checks; verify source/build freshness. Run the Impeccable detector once on finished changed markup and inspect its findings rather than treating zero source findings as proof of usability. Keep test repositories/profiles isolated from user work.

## 13. Definition of done

For the subsequent implementation to be complete, all five critique findings must satisfy their acceptance conditions; local/whole-file/AI capabilities must remain available; no algorithm or workflow-permission regression may be introduced; and visual and keyboard checks must pass. The implementation review should record evidence and any remaining limitation. These are future acceptance requirements, not claims of completed validation.

## 14. Review and development handoff

The selected direction is Current version | editable Result | Incoming version. All five findings are in scope. Preserve the existing visual identity and workflow safeguards throughout the six development slices in section 11.

Before development begins, review this specification as the agreed target. Component names and exact internal module boundaries are implementation choices; the layout, interaction, data-preservation and acceptance contracts above are required. Any existing worktree implementation must be assessed against those contracts separately.

The subsequent optimization goal resumed development. The implementation now uses `ConflictWorkspace.tsx` for responsive pane layout and `ConflictEditor.tsx` for the single editable result and coherent Monaco history. The completion handoff uses the narrow, acknowledged `task-center-handoff.ts` path. Review evidence and remaining platform limits are recorded in [the validation record](evidence/conflict-resolver-uiux-validation.md).
