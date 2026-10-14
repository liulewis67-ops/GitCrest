# Conflict Resolver Enhancement Plan

Status: Phases 0 to 4 completed (2026-10-14: 21/21 targeted Vitest and `tsc --noEmit` pass); Phase 5 is optional and not started · Scope: `ConflictWindow` (three-way conflict resolution)

This builds on the JetBrains-style layout already shipped (Ours | Result | Theirs rows, gutter accept arrows, "Accept both", prev/next navigation, resolved counter). Three JetBrains features remain:

1. Line-level (and intra-line) diff highlighting inside each side
2. Ignore (×) a change
3. Apply non-conflicting changes (All / Ours / Theirs)

## 1. What we already have (facts that shape the plan)

| Asset | Where | Consequence |
| --- | --- | --- |
| Backend returns `baseContent`, `oursContent`, `theirsContent`, `resultContent`, `resultRevision` | `crates/gitcrest-core/src/features/workflows/conflicts.rs`, `dto/responses.rs` | All three features can be computed client-side from data we already receive. No API change is required. |
| Each stage is capped at 1 MiB | `MAX_CONFLICT_FILE_BYTES` in `git/conflicts.rs` | Worst case is bounded, so an in-browser O(ND) diff is acceptable. |
| Word-level LCS diff with a cell cap | `src/features/diff/model/inline-diff.ts` (`splitInlineDiff`) | Reusable for intra-line highlighting. It is not suitable for whole-file line diff (quadratic table). |
| `git2` crate (vendored libgit2) is already a dependency | `crates/gitcrest-core/Cargo.toml` | An authoritative backend merge (`merge_file`) is possible later without a new dependency. |
| Conflict parsing (`findConflictBlocks`, `replaceConflictBlock`) lives inside `ConflictWindow.tsx` | `src/features/workflows/ui/ConflictWindow.tsx` | Move it into `model/` before adding more logic. The component is already large. |
| Git has already auto-merged non-conflicting hunks into `resultContent` | `git merge` / `cherry-pick` / `rebase` behavior | See section 4: "apply non-conflicting" only matters in specific situations. |

## 2. Shared foundation (Phase 0)

New pure modules under `src/features/workflows/model/`, with no React or network:

- `conflict-blocks.ts`: moved `findConflictBlocks`, `replaceConflictBlock`, marker regexes. Block gains a stable `id` (derived from start offset plus content hash) so UI state survives re-parse.
- `line-diff.ts`: line-level Myers diff.
  - API: `diffLines(a: string[], b: string[]): DiffOp[]` where an op is `equal | delete | insert` with index ranges.
  - Splits on `\n`, preserves `\r` as part of the line text so CRLF files round-trip.
  - Safety valve: if `N + M` is above a threshold, or edit distance exceeds a cap, return `null`. The caller renders without highlighting. This mirrors the `MAX_LCS_CELLS` pattern in `inline-diff.ts`.
- `merge3.ts`: line-based three-way merge (diff3).
  - API: `merge3(base, ours, theirs): Merge3Region[]`, where a region is `stable | oursOnly | theirsOnly | bothSame | conflict`. Each region carries its base/ours/theirs line ranges.
  - Built on `diffLines(base, ours)` and `diffLines(base, theirs)`, then aligned into regions. Overlapping hunks that differ are a `conflict`. Identical changes on both sides collapse to `bothSame`.
  - Hunks that touch (adjacent lines) are grouped into one conflict, matching Git. Adjacent edits are never combined silently. (The original draft proposed splitting them; the Git differential test showed that is riskier and diverges from Git.)

Why client-side rather than a backend endpoint: it needs no OpenAPI or schema change, it is instantly interactive, and the conflict window runs under a restricted capability (`windowAccess: "conflictResolution"`), so no new permission surface is added. The trade-off (possible differences from git's own merge on edge cases) is addressed by differential testing in section 7 and by the optional Phase 5.

## 3. Feature A: line-level diff inside each side (Phase 1)

Goal: in every conflict row, the user sees exactly which lines and words changed, not two opaque blobs.

Behavior:
- When the block has a base (diff3 markers, or `merge3` found the region): diff Ours vs Base and Theirs vs Base. Added or changed lines are tinted and get a `+`/`~` marker, and removed lines appear as a thin "removed" strip. This is the JetBrains convention (changes shown relative to the common ancestor).
- Without a base: diff Ours vs Theirs directly (still useful, since the common lines dim).
- Within a changed line pair, apply `splitInlineDiff` to highlight the changed words (second-level highlight).
- The Result column shows the base text (real base text via `merge3` even without diff3 markers, replacing the current "Unresolved" placeholder), with a "Base" caption.
- Line numbers in each side (actual file line numbers, so the user can correlate with the editor).

UI sketch of one row:

```
Conflict 2 · Line 41                                                    
┌─────────────────────┬──┬─────────────────────┬──┬─────────────────────┐
│ OURS                │» │ RESULT (base)       │ «│ THEIRS              │
│ 41   const a = 1;   │× │ 41   const a = 0;   │ ×│ 41   const a = 2;   │
│ 42 + log("x");      │  │                     │  │                     │
└─────────────────────┴──┴─────────────────────┴──┴─────────────────────┘
```

Files: `line-diff.ts`, new `ConflictSideLines.tsx` (renders tinted lines and tokens), CSS additions. Cap: skip highlighting for sides over about 2,000 lines per block or when `diffLines` returns `null`; show a one-line notice instead.

Accessibility: tint is never the only signal. Each changed line carries a text marker (`+`, `~`, `−`) and `aria-label`s such as "added line" / "changed line". Contrast is checked in both themes.

## 4. Feature C: apply non-conflicting changes (Phase 3)

Important nuance: for a normal merge, cherry-pick or rebase, Git already applied non-conflicting hunks to the working-tree result. So this button is **not** needed for the first view of a file. It earns its place when:

1. The user clicked "Use entire ours" (or theirs) and wants the other side's non-conflicting changes back.
2. The user wants to rebuild the result after a mistake.
3. Git coalesced nearby hunks into one big conflict, and `merge3` can split it into smaller real conflicts plus auto-appliable regions.

Design:
- Toolbar menu "Apply non-conflicting": **All**, **From ours**, **From theirs** (the JetBrains trio).
- Semantics: run `merge3(base, ours, theirs)` on the stages; build new result text where
  - `stable`, `bothSame` → emitted once;
  - `oursOnly` → emitted if All or Ours; otherwise left as base;
  - `theirsOnly` → emitted if All or Theirs; otherwise left as base;
  - `conflict` → emitted as standard conflict markers (diff3 style so base stays visible).
- Overwrite safety: this rebuilds the whole result. If the draft contains manual edits (draft differs from the last generated or saved result) show a confirm ("Replace your edits?"). Always push the previous draft onto the undo stack (below), so the action is reversible.
- Disabled when the file has no base and no ours/theirs both present (add/add or delete/modify). Label explains why.
- Counter: after applying, show "N changes applied · M conflicts left".

## 5. Feature B: ignore (×) (Phase 2)

JetBrains semantics: × discards one side's change for this chunk without applying it. A chunk is resolved once every side is either applied or ignored. For our model:

- Per block, UI state `{ oursIgnored, theirsIgnored }` (keyed by block `id`, held in `ConflictWindow` state, reset when the file reloads). It cannot live in the file because the working-tree content only supports Git markers.
- Rules:

| Ours | Theirs | Result of the block |
| --- | --- | --- |
| ignored | pending | stays unresolved, only `«` remains active, ours column dimmed |
| pending | ignored | stays unresolved, only `»` remains active, theirs column dimmed |
| ignored | ignored | resolved to **base** text (needs base from diff3 markers or `merge3`) |
| applied (`»`) then ignore theirs | | resolved to ours |
| applied both | | ours then theirs (existing "Accept both") |

- The × is a 26px gutter button under the accept arrow, labeled "Ignore ours for conflict N" / "Ignore theirs for conflict N". Dimmed columns also get a text label ("ignored"), not color alone.
- Counter treats a fully ignored block as resolved.
- Edge case: base absent (add/add conflict) means base is empty, so ignoring both yields an empty block. Show that explicitly ("will remove this block") and require the existing click on × twice, not a silent delete.

### Undo (needed by B and C)

Programmatic edits to a controlled `<textarea>` break the browser's native undo. Add a small history stack in a `useDraftHistory` hook (`push(prev)`, `undo()`, `redo()`), cap about 50 entries, cleared on file switch. Toolbar buttons "Undo" and "Redo" plus `Ctrl+Z` / `Ctrl+Shift+Z` when focus is not inside the textarea (the textarea keeps its native typing undo).

## 6. Phases, order, and rough effort

| Phase | Content | Depends on | Rough size |
| --- | --- | --- | --- |
| 0 | Extract `conflict-blocks.ts`; add `line-diff.ts`, `merge3.ts` with tests | none | 1.5 to 2 days |
| 1 | Line and intra-line highlighting, real base in the Result column, line numbers | 0 | 1.5 days |
| 2 | Ignore (×), `useDraftHistory` undo/redo | 0 | 1 day |
| 3 | Apply non-conflicting (All / Ours / Theirs) | 0, 2 (undo) | 1 day |
| 4 | Polish: keyboard shortcuts, narrow-window layout, empty and giant-file states, e2e update | 1 to 3 | 1 day |
| 5 (optional) | Backend `git merge-file --diff3` / `git2::merge_file` endpoint as the authority, if parity tests show drift | 0 | 1.5 days plus API doc and schema regen |

Ship order recommendation: 0 → 1 → 2 → 3. Phase 1 alone gives the largest visible improvement. Each phase is independently releasable.

## 7. Testing strategy

- **Unit, `line-diff`**: reconstruction property (applying ops to `a` yields `b`) over randomized inputs; CRLF; empty inputs; no trailing newline; cap fallback returns `null`.
- **Unit, `merge3`**: table-driven cases: one side changed, both same change, both different (conflict), adjacent non-overlapping hunks, delete versus modify, add/add, empty base, CRLF, no trailing newline.
- **Differential test against Git** (runs under the e2e config, which already uses real `git` fixtures in `tests/e2e/keyboard-workflow.test.ts`): generate random three-way inputs, run `git merge-file -p --diff3`, and assert that we agree on whether any conflict exists and that conflict-free output is byte-identical. Git may coalesce neighbouring conflicts into fewer, larger ones, so counts are not compared.
- **Component tests** (extend `tests/unit/conflict-window.test.tsx`): ignore rules table, both-ignored resolves to base, apply non-conflicting variants, overwrite confirm when the draft is dirty, undo and redo, counter text.
- **E2E**: extend the existing keyboard workflow with ignore and apply-non-conflicting, keyboard only (the project already tests this way).
- **Accessibility**: axe-style check for the new controls, focus order (gutter buttons reachable by Tab in row order), non-color signals present.

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Client `merge3` disagrees with Git on edge cases, producing a result the user did not expect | Never auto-write to disk; results land in the draft, are reviewable, and Save is explicit. Differential tests. Phase 5 fallback. |
| Large files (up to 1 MiB per stage) freeze the UI | Myers with an edit-distance cap, `null` fallback to plain rendering, optional Web Worker if profiling shows more than 50 ms. |
| Ignored-state is lost on window close | Documented limitation; the file on disk only contains what has been applied. Unsaved-changes guard already exists (`beforeunload`). Consider a persisted note only if users ask. |
| Rebuilding the result discards manual edits | Confirm dialog plus undo stack. |
| `ConflictWindow.tsx` keeps growing | Phase 0 extraction; split row rendering into `ConflictBlockRow.tsx`. |
| Style drift from the project | Reuse tokens (`--accent-soft`, `--green-soft`, etc.) and the `conflict*` class naming. Check `doc/06-design-language.md`, `07-interaction-accessibility.md` and `15-frontend-development-guidelines.md` during Phase 0 and note deviations. |

## 9. Decisions needed before starting

1. **× semantics**: per-side ignore with state tracked in the UI (recommended, matches JetBrains), or a simpler single "Use base" button per block?
2. **Computation location**: client-side only (recommended; Phase 5 stays optional), or backend-authoritative from the start?
3. **Overwrite policy** for "Apply non-conflicting" when the draft is dirty: confirm and replace (recommended), or disable the action until the draft is saved?
4. **Persistence of ignored state** across window reopen: accept loss (recommended for v1) or store it?

## 10. Acceptance criteria

- Every conflict row highlights changed lines and words relative to base, with text markers, in both themes.
- × on either side behaves as in the table in section 5, and the counter reflects it.
- "Apply non-conflicting" (All / Ours / Theirs) produces a draft whose conflicting regions are still marked and whose non-conflicting regions match the chosen side, and it is undoable.
- No change to the HTTP API or to what the sidecar persists unless Phase 5 is approved.
- All existing conflict-window unit and e2e tests still pass, plus the new tests above.

## 11. Implementation notes (as built)

Decisions taken: per-side ignore with UI-held state; client-side merge only; confirm before replacing unsaved edits; ignored state not persisted.

| Area | Files |
| --- | --- |
| Line diff (Myers, edit-distance cap 1500) | `src/features/workflows/model/line-diff.ts` |
| Three-way merge, render of non-conflicting changes | `model/merge3.ts` |
| Marker parsing, block ids, base lookup | `model/conflict-blocks.ts` |
| Undo/redo of programmatic draft changes | `model/use-draft-history.ts` |
| Line and word highlighting | `ui/ConflictSideLines.tsx` (reuses `splitInlineDiff`) |
| Row with accept, ignore and accept-both controls | `ui/ConflictBlockRow.tsx` |
| Toolbar, state, shortcuts | `ui/ConflictWindow.tsx` |
| Tests | `tests/unit/conflict-merge-model.test.ts`, `tests/unit/conflict-window.test.tsx` |

Behavior worth knowing:
- Without diff3 markers, a block's base is found by matching its ours/theirs text to a conflict from the stage merge. If Git grouped hunks differently there is no match, the row says "Base unavailable", and the sides are compared with each other.
- "Apply non-conflicting" is disabled when a side is absent (deleted file), when a stage is too different to diff, or when nothing applicable exists.
- Typing in the textarea records one undo step per typing session; Ctrl+Z inside the textarea stays native.
- Not done (accepted as out of scope for this pass): the Electron e2e flow was not re-run, Phase 5 (backend merge) is not started, and no visual check in the running app yet.
