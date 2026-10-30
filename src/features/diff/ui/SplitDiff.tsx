import { useI18n } from "../../../shared/i18n";
import type { DiffDocumentResponse } from "../../../api/client";
import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OTHER_STRUCTURE_ID, rowKey, structureSelection, type ReviewStructure, type SideLine } from "../model/code-review-analysis";
import { splitInlineDiff } from "../model/inline-diff";
import { monacoLanguageForPath } from "../model/monaco-language";
import { exceedsMonacoViewLimits } from "../model/monaco-view-limits";
import { rowState, selectedRowCount, selectedRowKeys, selectionFromKeys, withRows, withRowState, withoutRows, type DiffSelectionItem, type RowSelectionState } from "../model/row-selection";
import { dependencyHints, selectedDebugRows } from "../model/selection-hints";
import { useCodeReviewAnalysis } from "../model/use-code-review-analysis";
import { DiffStatusNotice } from "./DiffStatusNotice";
import { BlameAnnotation, blameGutterLabel, type BlameLookup } from "./BlameAnnotation";
import { StructureOutline, structureDisplayName, type StructureSelectionControls } from "./StructureOutline";

const MonacoDiffHunk = lazy(() => import("./MonacoDiffHunk").then((module) => ({ default: module.MonacoDiffHunk })));

/** The complete file behind a hunk document, so its changes can be grouped by code structure. */
export interface CodeReviewSource {
  /** The same file and scope read with `context=full`. */
  fullDocument?: DiffDocumentResponse;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  open: boolean;
  onToggle: () => void;
  /** A structure picked in the full-file view, to focus and select once the analysis is ready. */
  initialStructureId?: string;
  onInitialStructureHandled?: () => void;
}

interface SplitDiffProps {
  document: DiffDocumentResponse;
  onStageSelection: (selections: Array<{ hunkIndex: number; rowIndex?: number; side?: "old" | "new" }>) => void;
  onDiscardSelection?: (selections: Array<{ hunkIndex: number; rowIndex?: number; side?: "old" | "new" }>) => void;
  onCommitSelection?: (selections: Array<{ hunkIndex: number; rowIndex?: number; side?: "old" | "new" }>) => void;
  disabled: boolean;
  readOnly?: boolean;
  onOpenWindow?: () => void;
  onShowFullFile?: () => void;
  /** Hosts that already name the file and its side, like the Diff window header, drop the file row. */
  showFileMeta?: boolean;
  /** Annotates the new side's lines with their date and author, in a middle column between the two sides. */
  blame?: BlameLookup;
  codeReview?: CodeReviewSource;
  /** Two columns, or one column with deleted lines above added ones. Selecting rows works the same in both. */
  layout?: "split" | "unified";
}

export function SplitDiff({ document, onStageSelection, onDiscardSelection, onCommitSelection, disabled, readOnly: readOnlyOverride = false, onOpenWindow, onShowFullFile, showFileMeta = true, blame, codeReview, layout = "split" }: SplitDiffProps) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<DiffSelectionItem[]>([]);
  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(() => new Set());
  const [activeHunk, setActiveHunk] = useState<number | null>(null);
  const [view, setView] = useState<"split" | "monaco">("split");
  const [activeStructureId, setActiveStructureId] = useState<string | null>(null);
  // What the last structure selection left out or split, shown under its buttons.
  const [selectionNote, setSelectionNote] = useState({ withheld: 0, halves: 0 });
  const hunkRefs = useRef<Array<HTMLElement | null>>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeStructureIndex = useRef(0);
  const readOnly = readOnlyOverride || document.scope === "commit";
  const language = monacoLanguageForPath(document.path);
  const monacoDegraded = exceedsMonacoViewLimits(document.hunks);
  const reviewState = useCodeReviewAnalysis({
    path: document.path,
    fullDocument: codeReview?.fullDocument,
    fullLoading: codeReview?.loading,
    fullError: codeReview?.error,
    hunksDocument: document,
  });
  const showStructure = Boolean(codeReview) && reviewState.status !== "off" && document.status === "text";
  const analysis = reviewState.status === "ready" && reviewState.analysis.revision === document.revision ? reviewState.analysis : undefined;
  const structuresById = useMemo(() => new Map((analysis?.structures ?? []).map((structure) => [structure.id, structure])), [analysis]);
  const activeStructure = activeStructureId ? structuresById.get(activeStructureId) : undefined;
  const highlightedAtoms = useMemo(() => new Set(activeStructure ? [...activeStructure.atoms, ...activeStructure.memberAtoms] : []), [activeStructure]);
  const selectedKeys = useMemo(() => selectedRowKeys(document, selection), [document, selection]);
  // Monaco view shows each hunk's new-side lines in order; blame labels follow the same order.
  const monacoGutters = useMemo(() => blame
    ? document.hunks.map((hunk) => hunk.rows.flatMap((row) => row.newText === null || row.newText === undefined ? [] : [blameGutterLabel(blame(row.newLine, row.newText))]))
    : undefined, [blame, document.hunks]);
  const navigableHunks = useMemo(() => document.status === "text"
    ? document.hunks.flatMap((hunk, hunkIndex) => hunk.rows.some((row) => row.kind === "change") ? [hunkIndex] : [])
    : [], [document.hunks, document.status]);
  useEffect(() => {
    setSelection([]);
    setCollapsedHunks(new Set());
    setActiveHunk(null);
    setView("split");
    setSelectionNote({ withheld: 0, halves: 0 });
    hunkRefs.current = [];
  }, [document.revision]);
  useEffect(() => {
    setActiveStructureId(null);
    activeStructureIndex.current = 0;
  }, [document.path, document.scope]);
  // After staging, keep the focused structure while it still has changes, or move to the one that took its place.
  useEffect(() => {
    if (!analysis || !activeStructureId || structuresById.has(activeStructureId)) return;
    const fallback = analysis.structures[Math.min(activeStructureIndex.current, analysis.structures.length - 1)];
    setActiveStructureId(fallback?.id ?? null);
  }, [analysis, activeStructureId, structuresById]);

  const revealRow = useCallback((hunkIndex: number, rowIndex: number | null) => {
    setCollapsedHunks((current) => {
      if (!current.has(hunkIndex)) return current;
      const next = new Set(current);
      next.delete(hunkIndex);
      return next;
    });
    setActiveHunk(hunkIndex);
    requestAnimationFrame(() => {
      const row = rowIndex === null ? null : rootRef.current?.querySelector(`[data-row="${rowKey(hunkIndex, rowIndex)}"]`);
      (row ?? hunkRefs.current[hunkIndex])?.scrollIntoView?.({ block: row ? "center" : "nearest" });
    });
  }, []);

  /** The displayed row closest to a line of one side; facts may point at an unchanged line. */
  const revealLine = useCallback((at: SideLine) => {
    let best: { hunkIndex: number; rowIndex: number; distance: number } | null = null;
    document.hunks.forEach((hunk, hunkIndex) => hunk.rows.forEach((row, rowIndex) => {
      const line = at.side === "old" ? row.oldLine : row.newLine;
      if (line === null) return;
      const distance = Math.abs(line - at.line);
      if (!best || distance < best.distance) best = { hunkIndex, rowIndex, distance };
    }));
    const found = best as { hunkIndex: number; rowIndex: number } | null;
    if (found) revealRow(found.hunkIndex, found.rowIndex);
  }, [document.hunks, revealRow]);

  const activateStructure = useCallback((structure: ReviewStructure) => {
    setActiveStructureId(structure.id);
    setSelectionNote({ withheld: 0, halves: 0 });
    activeStructureIndex.current = Math.max(0, analysis?.structures.indexOf(structure) ?? 0);
    const first = [...structure.atoms, ...structure.memberAtoms]
      .map((index) => analysis?.atoms[index]?.selection)
      .filter((item) => item !== undefined)
      .sort((a, b) => a.hunkIndex - b.hunkIndex || a.rowIndex - b.rowIndex)[0];
    if (first) revealRow(first.hunkIndex, first.rowIndex);
  }, [analysis, revealRow]);

  const structureControls = useMemo<StructureSelectionControls | undefined>(() => {
    if (readOnly || !analysis) return undefined;
    return {
      disabled,
      withheld: selectionNote.withheld,
      halves: selectionNote.halves,
      stateOf: (structure) => {
        const { rows } = structureSelection(analysis, structure.id, structure.memberAtoms.length > 0);
        const chosen = rows.filter((row) => {
          const state = rowState(selectedKeys, row.hunkIndex, row.rowIndex);
          return state === "all" || state === row.side;
        }).length;
        return rows.length > 0 && chosen === rows.length ? "all" : chosen > 0 ? "some" : "none";
      },
      select: (structure, includeMembers) => {
        const { rows, withheld, halves } = structureSelection(analysis, structure.id, includeMembers);
        setSelection(selectionFromKeys(document, withRows(selectedKeys, rows)));
        setSelectionNote({ withheld, halves });
      },
      deselect: (structure) => {
        const { touched } = structureSelection(analysis, structure.id, true);
        setSelection(selectionFromKeys(document, withoutRows(selectedKeys, touched)));
        setSelectionNote({ withheld: 0, halves: 0 });
      },
    };
  }, [analysis, disabled, document, readOnly, selectedKeys, selectionNote]);

  /** Sets one change row, or one side of it, and keeps the selection in diff order. */
  const setRowSelection = useCallback((hunkIndex: number, rowIndex: number, state: RowSelectionState) => {
    setSelection(selectionFromKeys(document, withRowState(selectedKeys, hunkIndex, rowIndex, state)));
  }, [document, selectedKeys]);

  // A structure chosen in the full-file view is focused and selected here once its analysis is ready.
  const initialStructureId = codeReview?.initialStructureId;
  const onInitialStructureHandled = codeReview?.onInitialStructureHandled;
  useEffect(() => {
    if (!initialStructureId || reviewState.status === "analyzing") return;
    const structure = structuresById.get(initialStructureId);
    if (structure) {
      activateStructure(structure);
      if (structure.reliable) structureControls?.select(structure, structure.atoms.length === 0);
    }
    onInitialStructureHandled?.();
    // Runs once per requested structure, when the analysis settles.
  }, [initialStructureId, reviewState.status, structuresById]);

  const navigateHunk = useCallback((direction: -1 | 1) => {
    if (navigableHunks.length === 0) return;
    const activeIndex = activeHunk === null ? -1 : navigableHunks.indexOf(activeHunk);
    const nextIndex = activeIndex === -1
      ? (direction === 1 ? 0 : navigableHunks.length - 1)
      : (activeIndex + direction + navigableHunks.length) % navigableHunks.length;
    const nextHunk = navigableHunks[nextIndex];
    if (nextHunk === undefined) return;
    setCollapsedHunks((current) => {
      if (!current.has(nextHunk)) return current;
      const next = new Set(current);
      next.delete(nextHunk);
      return next;
    });
    setActiveHunk(nextHunk);
    requestAnimationFrame(() => hunkRefs.current[nextHunk]?.scrollIntoView?.({ block: "nearest" }));
  }, [activeHunk, navigableHunks]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F7" || event.altKey || event.ctrlKey || event.metaKey || navigableHunks.length === 0) return;
      if (event.target instanceof HTMLElement && event.target.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      navigateHunk(event.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [document.revision, navigateHunk, navigableHunks.length]);
  if (document.status !== "text") return <DiffStatusNotice status={document.status} />;

  const selectionSummary = analysis && selectedKeys.size > 0 ? summarizeSelection() : null;
  const dependencies = analysis && !readOnly ? dependencyHints(analysis, selectedKeys) : [];
  const debugRows = analysis && !readOnly ? selectedDebugRows(analysis, selectedKeys) : [];
  function summarizeSelection() {
    const names: string[] = [];
    for (const key of selectedKeys) {
      const [hunkIndex, rowIndex, side] = key.split(":");
      const atomIndex = analysis?.rowAtoms.get(`${hunkIndex}:${rowIndex}`);
      const atom = atomIndex === undefined ? undefined : analysis?.atoms[atomIndex];
      const owners = !atom ? [] : side === "old" ? atom.oldOwners : side === "new" ? atom.newOwners : atom.owners;
      for (const owner of owners) {
        const structure = structuresById.get(owner);
        const name = structure ? structureDisplayName(structure, t) : t("cr.other");
        if (!names.includes(name)) names.push(name);
      }
    }
    return t("cr.selectionIn", { count: selectedRowCount(selectedKeys), names: names.length > 3 ? `${names.slice(0, 3).join(", ")}…` : names.join(", ") });
  }

  function toggleSide(hunkIndex: number, rowIndex: number, state: RowSelectionState, side: "old" | "new") {
    const old = state === "all" || state === "old";
    const added = state === "all" || state === "new";
    const nextOld = side === "old" ? !old : old;
    const nextNew = side === "new" ? !added : added;
    setRowSelection(hunkIndex, rowIndex, nextOld && nextNew ? "all" : nextOld ? "old" : nextNew ? "new" : "none");
  }

  /** The structures a hunk changes, in order, so its header names them instead of Git's guessed context. */
  function hunkStructureNames(hunkIndex: number): string {
    if (!analysis) return "";
    const names: string[] = [];
    document.hunks[hunkIndex]?.rows.forEach((row, rowIndex) => {
      if (row.kind !== "change") return;
      const atomIndex = analysis.rowAtoms.get(rowKey(hunkIndex, rowIndex));
      for (const owner of atomIndex === undefined ? [] : analysis.atoms[atomIndex]?.owners ?? []) {
        if (owner === OTHER_STRUCTURE_ID) continue;
        const path: string[] = [];
        for (let current = structuresById.get(owner); current; current = current.parentId ? structuresById.get(current.parentId) : undefined) {
          path.unshift(structureDisplayName(current, t));
        }
        const name = path.join(" › ");
        if (name && !names.includes(name)) names.push(name);
      }
    });
    return names.length > 3 ? `${names.slice(0, 3).join(" · ")} …` : names.join(" · ");
  }

  const diff = (
    <div
      ref={rootRef}
      className={showFileMeta ? "splitDiff" : "splitDiff noFileMeta"}
      aria-label={t("sd.diffAria", { scope: document.scope, path: document.path })}
      tabIndex={0}
    >
      {showFileMeta && <div className="splitDiffFileMeta"><span className="diffScopeBadge">{document.scope === "commit" ? t("sd.scopeCommit") : document.scope === "index" ? t("sd.scopeIndex") : t("sd.scopeWorking")}</span><strong>{document.path}</strong>{document.originalPath && <small>{document.originalPath} → {document.path}</small>}</div>}
      <div className="splitDiffNavigation" aria-label={t("sd.navAria")}>
        <span>{navigableHunks.length ? t("sd.changes", { current: activeHunk === null ? 0 : navigableHunks.indexOf(activeHunk) + 1, total: navigableHunks.length }) : t("sd.noChanges")}</span>
        {showStructure && codeReview && <button type="button" aria-pressed={codeReview.open} title={t("cr.toggleTitle")} onClick={codeReview.onToggle}>{t("cr.toggle")}</button>}
        {onShowFullFile && <button type="button" title={t("fd.fullFileTitle")} onClick={onShowFullFile}>{t("fd.fullFile")}</button>}
        <button type="button" aria-pressed={view === "split"} onClick={() => setView("split")}>{t("sd.splitView")}</button>
        <button type="button" aria-pressed={view === "monaco"} disabled={monacoDegraded} title={monacoDegraded ? t("sd.monacoTooLargeTitle") : undefined} onClick={() => setView("monaco")}>{t("sd.monacoView")}</button>
        {onOpenWindow && <button type="button" onClick={onOpenWindow}>{t("sd.openWindow")}</button>}
        <button type="button" onClick={() => navigateHunk(-1)} disabled={navigableHunks.length === 0} title={t("sd.prevTitle")}>{t("sd.prev")}</button>
        <button type="button" onClick={() => navigateHunk(1)} disabled={navigableHunks.length === 0} title={t("sd.nextTitle")}>{t("sd.next")}</button>
      </div>
      {monacoDegraded && <div className="diffSyntaxFallback" role="status">{t("sd.monacoTooLarge")}</div>}
      <div className={blame ? "splitDiffColumns withBlame" : "splitDiffColumns"} aria-hidden="true"><div /><div>{t("sd.old")}</div>{blame && <div />}<div>{t("sd.new")}</div></div>
      {view === "monaco" && !language.supported && <div className="diffSyntaxFallback" role="status">{t("sd.noGrammar")}</div>}
      {document.hunks.map((hunk, hunkIndex) => {
        const changeRowIndexes = hunk.rows.flatMap((row, rowIndex) => row.kind === "change" ? [rowIndex] : []);
        const rowStates = changeRowIndexes.map((rowIndex) => rowState(selectedKeys, hunkIndex, rowIndex));
        const allRowsSelected = rowStates.length > 0 && rowStates.every((state) => state === "all");
        const someRowsSelected = !allRowsSelected && rowStates.some((state) => state !== "none");
        const hunkStructures = hunkStructureNames(hunkIndex);
        return (
        <section
          className={`splitDiffHunk${activeHunk === hunkIndex ? " splitDiffHunk-active" : ""}`}
          key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}
          aria-label={t("sd.hunkAria", { n: hunkIndex + 1 })}
          ref={(element) => { hunkRefs.current[hunkIndex] = element; }}
        >
          <div className="splitDiffHunkHeader">
            {!readOnly ? <label className="hunkSelection"><input
              type="checkbox"
              aria-label={t("sd.selectHunkAria", { n: hunkIndex + 1 })}
              checked={allRowsSelected}
              ref={(element) => { if (element) element.indeterminate = someRowsSelected; }}
              disabled={disabled || changeRowIndexes.length === 0}
              onChange={(event) => {
                let keys: Set<string> = new Set(selectedKeys);
                for (const rowIndex of changeRowIndexes) keys = withRowState(keys, hunkIndex, rowIndex, event.target.checked ? "all" : "none");
                setSelection(selectionFromKeys(document, keys));
              }}
            />{t("sd.selectHunk")}</label> : <span className="hunkSelection">{t("sd.hunkLabel", { n: hunkIndex + 1 })}</span>}
            <code>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</code>
            {hunkStructures && <span className="hunkStructures" title={hunkStructures}>{hunkStructures}</span>}
            <button
              type="button"
              className="diffHunkToggle"
              aria-expanded={!collapsedHunks.has(hunkIndex)}
              aria-label={collapsedHunks.has(hunkIndex) ? t("sd.expandAria", { n: hunkIndex + 1 }) : t("sd.collapseAria", { n: hunkIndex + 1 })}
              onClick={() => setCollapsedHunks((current) => {
                const next = new Set(current);
                if (next.has(hunkIndex)) next.delete(hunkIndex);
                else next.add(hunkIndex);
                return next;
              })}
            >{collapsedHunks.has(hunkIndex) ? t("sd.expand") : t("sd.collapse")}</button>
          </div>
          {!collapsedHunks.has(hunkIndex) && view === "monaco" && <Suspense fallback={<div className="monacoDiffLoading" role="status">{t("sd.loadingMonaco")}</div>}>
            <MonacoDiffHunk
              label={t("sd.monacoHunk", { n: hunkIndex + 1 })}
              original={hunk.rows.flatMap((row) => row.oldText === null || row.oldText === undefined ? [] : [row.oldText]).join("\n")}
              modified={hunk.rows.flatMap((row) => row.newText === null || row.newText === undefined ? [] : [row.newText]).join("\n")}
              language={language.id}
              treeSitterGrammar={language.treeSitterGrammar}
              height={Math.min(480, Math.max(120, hunk.rows.length * 20 + 24))}
              modifiedGutter={monacoGutters?.[hunkIndex]}
            />
          </Suspense>}
          {!collapsedHunks.has(hunkIndex) && view === "split" && layout === "unified" && hunk.rows.map((row, rowIndex) => {
            const state = row.kind === "change" ? rowState(selectedKeys, hunkIndex, rowIndex) : "none";
            const paired = row.kind === "change" && !readOnly && row.oldText !== null && row.newText !== null;
            if (row.kind === "context") {
              return <div className="unifiedDiffRow unifiedSelectable" role="group" aria-label={t("sd.contextLine", { line: row.oldLine ?? row.newLine ?? t("sd.unknown"), text: row.oldText ?? row.newText ?? "" })} data-row={rowKey(hunkIndex, rowIndex)} key={`${hunkIndex}:${rowIndex}`}><span className="diffRowSelect" aria-hidden="true" /><span>{row.oldLine ?? ""}</span><span>{row.newLine ?? ""}</span><code>{row.oldText ?? row.newText ?? ""}</code></div>;
            }
            // One checkbox per line. A line that is half of a paired row selects only its own side.
            const lineBox = (side: "old" | "new") => {
              if (readOnly) return <span className="diffRowSelect" aria-hidden="true" />;
              const checked = paired ? state === "all" || state === side : state === "all";
              return <label className="diffRowSelect"><input
                type="checkbox"
                aria-label={side === "old" ? t("sd.selectDeletedLineAria", { hunk: hunkIndex + 1, row: rowIndex + 1 }) : t("sd.selectAddedLineAria", { hunk: hunkIndex + 1, row: rowIndex + 1 })}
                checked={checked}
                disabled={disabled}
                onChange={(event) => paired ? toggleSide(hunkIndex, rowIndex, state, side) : setRowSelection(hunkIndex, rowIndex, event.target.checked ? "all" : "none")}
              /></label>;
            };
            const atomIndex = analysis?.rowAtoms.get(rowKey(hunkIndex, rowIndex));
            const inStructure = atomIndex !== undefined && highlightedAtoms.has(atomIndex);
            return <Fragment key={`${hunkIndex}:${rowIndex}`}>
              {row.oldText !== null && row.oldText !== undefined && <div className={`unifiedDiffRow unifiedDiffDeletion unifiedSelectable${inStructure ? " splitDiffRow-structure" : ""}`} role="group" aria-label={t("sd.deletedLine", { line: row.oldLine ?? t("sd.unknown"), text: row.oldText })} data-row={rowKey(hunkIndex, rowIndex)}>{lineBox("old")}<span>{row.oldLine ?? ""}</span><span /><code><span aria-hidden="true">- </span>{row.newText !== null && row.newText !== undefined ? <InlineDiffText text={row.oldText} counterpart={row.newText} /> : row.oldText}</code></div>}
              {row.newText !== null && row.newText !== undefined && <div className={`unifiedDiffRow unifiedDiffAddition unifiedSelectable${inStructure ? " splitDiffRow-structure" : ""}`} role="group" aria-label={t("sd.addedLine", { line: row.newLine ?? t("sd.unknown"), text: row.newText })} data-row={row.oldText === null || row.oldText === undefined ? rowKey(hunkIndex, rowIndex) : undefined}>{lineBox("new")}<span /><span>{row.newLine ?? ""}</span><code><span aria-hidden="true">+ </span>{row.oldText !== null && row.oldText !== undefined ? <InlineDiffText text={row.newText} counterpart={row.oldText} /> : row.newText}</code></div>}
            </Fragment>;
          })}
          {!collapsedHunks.has(hunkIndex) && view === "split" && layout === "split" && hunk.rows.map((row, rowIndex) => {
            const state = row.kind === "change" ? rowState(selectedKeys, hunkIndex, rowIndex) : "none";
            // Only a row with both a deleted and an added line can be selected one side at a time.
            const paired = row.kind === "change" && !readOnly && row.oldText !== null && row.newText !== null;
            const atomIndex = row.kind === "change" ? analysis?.rowAtoms.get(rowKey(hunkIndex, rowIndex)) : undefined;
            const atom = atomIndex === undefined ? undefined : analysis?.atoms[atomIndex];
            const inStructure = atomIndex !== undefined && highlightedAtoms.has(atomIndex);
            const sharedWith = atom && atom.owners.length > 1 && inStructure
              ? atom.owners.filter((owner) => owner !== activeStructureId).map((owner) => {
                const structure = structuresById.get(owner);
                return structure ? structureDisplayName(structure, t) : t("cr.other");
              }).join(", ")
              : "";
            return (
            <div
              className={`splitDiffRow splitDiffRow-${row.kind}${blame ? " withBlame" : ""}${inStructure ? " splitDiffRow-structure" : ""}${sharedWith ? " splitDiffRow-shared" : ""}${atom?.debug ? " splitDiffRow-debug" : ""}`}
              role="group"
              aria-label={row.kind === "change" ? t("sd.changedLines") : t("sd.contextLines")}
              title={sharedWith ? t("cr.sharedRowTitle", { names: sharedWith }) : atom?.debug ? t("cr.debugRowTitle") : undefined}
              data-row={rowKey(hunkIndex, rowIndex)}
              key={`${hunkIndex}:${rowIndex}`}
            >
              {row.kind === "change" && !readOnly ? <label className="diffRowSelect"><input
                type="checkbox"
                aria-label={t("sd.selectRowAria", { hunk: hunkIndex + 1, row: rowIndex + 1 })}
                checked={state === "all"}
                ref={(element) => { if (element) element.indeterminate = state === "old" || state === "new"; }}
                disabled={disabled}
                onChange={(event) => setRowSelection(hunkIndex, rowIndex, event.target.checked ? "all" : "none")}
              /></label> : <span className="diffRowSelect" aria-hidden="true" />}
              <div
                className="splitDiffCell"
                role="group"
                aria-label={row.oldText === null
                  ? t("sd.noPrevious")
                  : row.kind === "change"
                    ? t("sd.deletedLine", { line: row.oldLine ?? t("sd.unknown"), text: row.oldText })
                    : t("sd.contextLine", { line: row.oldLine ?? t("sd.unknown"), text: row.oldText })}
              >
                <span className="splitDiffLineNumber">{paired && <input
                  className="diffSideSelect"
                  type="checkbox"
                  aria-label={t("sd.selectOldSideAria", { line: row.oldLine ?? "" })}
                  title={t("sd.selectSideTitle")}
                  checked={state === "all" || state === "old"}
                  disabled={disabled}
                  onChange={() => toggleSide(hunkIndex, rowIndex, state, "old")}
                />}{row.oldLine ?? ""}</span>
                <code>{row.oldText !== null && row.oldText !== undefined && row.kind === "change" ? <InlineDiffText text={row.oldText} counterpart={row.newText ?? null} /> : row.oldText ?? ""}</code>
              </div>
              {blame && <BlameAnnotation line={blame(row.newLine, row.newText)} />}
              <div
                className="splitDiffCell"
                role="group"
                aria-label={row.newText === null
                  ? t("sd.noAdded")
                  : row.kind === "change"
                    ? t("sd.addedLine", { line: row.newLine ?? t("sd.unknown"), text: row.newText })
                    : t("sd.contextLine", { line: row.newLine ?? t("sd.unknown"), text: row.newText })}
              >
                <span className="splitDiffLineNumber">{paired && <input
                  className="diffSideSelect"
                  type="checkbox"
                  aria-label={t("sd.selectNewSideAria", { line: row.newLine ?? "" })}
                  title={t("sd.selectSideTitle")}
                  checked={state === "all" || state === "new"}
                  disabled={disabled}
                  onChange={() => toggleSide(hunkIndex, rowIndex, state, "new")}
                />}{row.newLine ?? ""}</span>
                <code>{row.newText !== null && row.newText !== undefined && row.kind === "change" ? <InlineDiffText text={row.newText} counterpart={row.oldText ?? null} /> : row.newText ?? ""}</code>
                {atom?.debug && <span className="debugBadge" aria-label={t("cr.debugRowTitle")}>{t("cr.debugBadge")}</span>}
              </div>
            </div>
            );
          })}
        </section>
        );
      })}
      {!readOnly && <div className="diffSelectionActions">
        {(dependencies.length > 0 || debugRows.length > 0) && <div className="diffSelectionHints" role="status">
          {dependencies.map((hint) => <p key={hint.name}>
            <span>{t("cr.dependency", { name: hint.name })}</span>
            <button type="button" disabled={disabled} onClick={() => setSelection(selectionFromKeys(document, withRows(selectedKeys, hint.rows)))}>{t("cr.includeDependency")}</button>
          </p>)}
          {debugRows.length > 0 && <p>
            <span>{t("cr.debugSelected", { count: debugRows.length })}</span>
            <button type="button" disabled={disabled} onClick={() => setSelection(selectionFromKeys(document, withoutRows(selectedKeys, debugRows)))}>{t("cr.deselectDebug")}</button>
          </p>}
        </div>}
        <span>{t(selection.length === 1 ? "sd.selectionOne" : "sd.selectionMany", { count: selection.length })}{selectionSummary && <small className="diffSelectionStructures"> · {selectionSummary}</small>}</span>
        <button type="button" disabled={disabled || selection.length === 0} onClick={() => onStageSelection(selection)}>
          {document.scope === "index" ? t("sd.unstageSel") : t("sd.stageSel")}
        </button>
        {document.scope === "workingTree" && onDiscardSelection && <button className="dangerTextButton" type="button" disabled={disabled || selection.length === 0} onClick={() => onDiscardSelection(selection)}>{t("sd.discardSel")}</button>}
        {document.scope === "index" && onCommitSelection && <button type="button" disabled={disabled || selection.length === 0} onClick={() => onCommitSelection(selection)}>{t("sd.addToCommit")}</button>}
      </div>}
    </div>
  );

  if (!showStructure || !codeReview) return diff;
  return (
    <div className={`codeReviewFrame${codeReview.open ? " outlineOpen" : ""}`}>
      {codeReview.open && <StructureOutline
        state={reviewState}
        activeId={activeStructureId}
        onActivate={activateStructure}
        onJump={revealLine}
        reviewKey={document.scope === "commit" ? undefined : `${document.repoId}\u0000${document.scope}\u0000${document.path}`}
        selection={structureControls}
        onRefresh={codeReview.onRefresh}
        onClose={codeReview.onToggle}
      />}
      <div className="codeReviewMain">{diff}</div>
    </div>
  );
}

function InlineDiffText({ text, counterpart }: { text: string; counterpart: string | null }) {
  const segments = splitInlineDiff(text, counterpart);
  return <>{segments.map((segment, index) => segment.changed
    ? <mark className="diffInlineChange" key={index}>{segment.text}</mark>
    : <span key={index}>{segment.text}</span>)}</>;
}
