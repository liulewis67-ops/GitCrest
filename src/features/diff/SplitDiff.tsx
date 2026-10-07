import type { DiffDocumentResponse } from "../../api/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitInlineDiff } from "./inline-diff";

interface SplitDiffProps {
  document: DiffDocumentResponse;
  onStageSelection: (selections: Array<{ hunkIndex: number; rowIndex?: number }>) => void;
  onCommitSelection?: (selections: Array<{ hunkIndex: number; rowIndex?: number }>) => void;
  disabled: boolean;
}

export function SplitDiff({ document, onStageSelection, onCommitSelection, disabled }: SplitDiffProps) {
  const [selection, setSelection] = useState<Array<{ hunkIndex: number; rowIndex?: number }>>([]);
  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(() => new Set());
  const [activeHunk, setActiveHunk] = useState<number | null>(null);
  const hunkRefs = useRef<Array<HTMLElement | null>>([]);
  const readOnly = document.scope === "commit";
  const navigableHunks = useMemo(() => document.status === "text"
    ? document.hunks.flatMap((hunk, hunkIndex) => hunk.rows.some((row) => row.kind === "change") ? [hunkIndex] : [])
    : [], [document.hunks, document.status]);
  useEffect(() => {
    setSelection([]);
    setCollapsedHunks(new Set());
    setActiveHunk(null);
    hunkRefs.current = [];
  }, [document.revision]);
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
  if (document.status !== "text") {
    const descriptions: Record<DiffDocumentResponse["status"], string> = {
      text: "Text diff",
      binary: "This file is binary; Git does not provide a line based diff.",
      empty: "No textual changes remain for this comparison. Refresh the working tree to check for external edits.",
      conflicted: "This file is conflicted. Three way conflict review is available in a later workflow stage.",
      ignored: "This path is ignored by Git and has no tracked diff.",
      symlink: "This path is a symbolic link. GitCrest shows its status without following its target.",
      submodule: "This path is a submodule. Its nested repository diff is not available yet.",
    };
    return <div className="diffSpecialState" role="status"><span className={`diffStateBadge diffState-${document.status}`}>{document.status}</span><p>{descriptions[document.status]}</p></div>;
  }

  return (
    <div
      className="splitDiff"
      aria-label={`${document.scope} diff for ${document.path}`}
      tabIndex={0}
    >
      <div className="splitDiffFileMeta"><span className="diffScopeBadge">{document.scope === "commit" ? "COMMIT ↔ FIRST PARENT" : document.scope === "index" ? "INDEX ↔ HEAD" : "WORKING TREE ↔ INDEX"}</span><strong>{document.path}</strong>{document.originalPath && <small>{document.originalPath} → {document.path}</small>}</div>
      <div className="splitDiffNavigation" aria-label="Diff navigation">
        <span>{navigableHunks.length ? `${activeHunk === null ? 0 : navigableHunks.indexOf(activeHunk) + 1} / ${navigableHunks.length} changes` : "No changes"}</span>
        <button type="button" onClick={() => navigateHunk(-1)} disabled={navigableHunks.length === 0} title="Previous change (Shift+F7)">Previous change</button>
        <button type="button" onClick={() => navigateHunk(1)} disabled={navigableHunks.length === 0} title="Next change (F7)">Next change</button>
      </div>
      <div className="splitDiffColumns" aria-hidden="true"><div /><div>OLD</div><div>NEW</div></div>
      {document.hunks.map((hunk, hunkIndex) => {
        const changeRowIndexes = hunk.rows.flatMap((row, rowIndex) => row.kind === "change" ? [rowIndex] : []);
        const hunkSelected = selection.some((item) => item.hunkIndex === hunkIndex && item.rowIndex === undefined);
        const allRowsSelected = changeRowIndexes.length > 0 && changeRowIndexes.every((rowIndex) => selection.some((item) => item.hunkIndex === hunkIndex && (item.rowIndex === undefined || item.rowIndex === rowIndex)));
        return (
        <section
          className={`splitDiffHunk${activeHunk === hunkIndex ? " splitDiffHunk-active" : ""}`}
          key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}
          aria-label={`Change hunk ${hunkIndex + 1}`}
          ref={(element) => { hunkRefs.current[hunkIndex] = element; }}
        >
          <div className="splitDiffHunkHeader">
            {!readOnly ? <label className="hunkSelection"><input
              type="checkbox"
              aria-label={`Select hunk ${hunkIndex + 1}`}
              checked={hunkSelected || allRowsSelected}
              disabled={disabled || changeRowIndexes.length === 0}
              onChange={(event) => setSelection((current) => {
                const rest = current.filter((item) => item.hunkIndex !== hunkIndex);
                return event.target.checked ? [...rest, { hunkIndex }] : rest;
              })}
            />Select hunk</label> : <span className="hunkSelection">Hunk {hunkIndex + 1}</span>}
            <code>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</code>
            <button
              type="button"
              className="diffHunkToggle"
              aria-expanded={!collapsedHunks.has(hunkIndex)}
              aria-label={`${collapsedHunks.has(hunkIndex) ? "Expand" : "Collapse"} hunk ${hunkIndex + 1}`}
              onClick={() => setCollapsedHunks((current) => {
                const next = new Set(current);
                if (next.has(hunkIndex)) next.delete(hunkIndex);
                else next.add(hunkIndex);
                return next;
              })}
            >{collapsedHunks.has(hunkIndex) ? "Expand" : "Collapse"}</button>
          </div>
          {!collapsedHunks.has(hunkIndex) && hunk.rows.map((row, rowIndex) => (
            <div className={`splitDiffRow splitDiffRow-${row.kind}`} key={`${hunkIndex}:${rowIndex}`}>
              {row.kind === "change" && !readOnly ? <label className="diffRowSelect"><input
                type="checkbox"
                aria-label={`Select hunk ${hunkIndex + 1} change row ${rowIndex + 1}`}
                checked={selection.some((item) => item.hunkIndex === hunkIndex && (item.rowIndex === undefined || item.rowIndex === rowIndex))}
                disabled={disabled}
                onChange={(event) => setSelection((current) => {
                  const isHunkSelected = current.some((item) => item.hunkIndex === hunkIndex && item.rowIndex === undefined);
                  const rows = isHunkSelected
                    ? changeRowIndexes.map((rowIndex) => ({ hunkIndex, rowIndex }))
                    : current.filter((item) => item.hunkIndex !== hunkIndex || item.rowIndex !== undefined);
                  const exists = rows.some((item) => item.hunkIndex === hunkIndex && item.rowIndex === rowIndex);
                  const next = event.target.checked
                    ? (exists ? rows : [...rows, { hunkIndex, rowIndex }])
                    : rows.filter((item) => !(item.hunkIndex === hunkIndex && item.rowIndex === rowIndex));
                  return [...next.filter((item) => item.hunkIndex !== hunkIndex), ...next.filter((item) => item.hunkIndex === hunkIndex)];
                })}
              /></label> : <span className="diffRowSelect" aria-hidden="true" />}
              <div className="splitDiffCell"><span className="splitDiffLineNumber">{row.oldLine ?? ""}</span><code>{row.oldText !== null && row.oldText !== undefined && row.kind === "change" ? <InlineDiffText text={row.oldText} counterpart={row.newText ?? null} /> : row.oldText ?? ""}</code></div>
              <div className="splitDiffCell"><span className="splitDiffLineNumber">{row.newLine ?? ""}</span><code>{row.newText !== null && row.newText !== undefined && row.kind === "change" ? <InlineDiffText text={row.newText} counterpart={row.oldText ?? null} /> : row.newText ?? ""}</code></div>
            </div>
          ))}
        </section>
        );
      })}
      {!readOnly && <div className="diffSelectionActions">
        <span>{selection.length} selection{selection.length === 1 ? "" : "s"}</span>
        <button type="button" disabled={disabled || selection.length === 0} onClick={() => onStageSelection(selection)}>
          {document.scope === "index" ? "Unstage selected changes" : "Stage selected changes"}
        </button>
        {document.scope === "index" && onCommitSelection && <button type="button" disabled={disabled || selection.length === 0} onClick={() => onCommitSelection(selection)}>Add to commit selection</button>}
      </div>}
    </div>
  );
}

function InlineDiffText({ text, counterpart }: { text: string; counterpart: string | null }) {
  const segments = splitInlineDiff(text, counterpart);
  return <>{segments.map((segment, index) => segment.changed
    ? <mark className="diffInlineChange" key={index}>{segment.text}</mark>
    : <span key={index}>{segment.text}</span>)}</>;
}
