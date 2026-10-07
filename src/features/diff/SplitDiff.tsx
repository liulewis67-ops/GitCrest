import type { DiffDocumentResponse } from "../../api/client";
import { useEffect, useState } from "react";

interface SplitDiffProps {
  document: DiffDocumentResponse;
  onStageSelection: (selections: Array<{ hunkIndex: number; rowIndex?: number }>) => void;
  onCommitSelection?: (selections: Array<{ hunkIndex: number; rowIndex?: number }>) => void;
  disabled: boolean;
}

export function SplitDiff({ document, onStageSelection, onCommitSelection, disabled }: SplitDiffProps) {
  const [selection, setSelection] = useState<Array<{ hunkIndex: number; rowIndex?: number }>>([]);
  const readOnly = document.scope === "commit";
  useEffect(() => setSelection([]), [document.revision]);
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
    <div className="splitDiff" aria-label={`${document.scope} diff for ${document.path}`}>
      <div className="splitDiffFileMeta"><span className="diffScopeBadge">{document.scope === "commit" ? "COMMIT ↔ FIRST PARENT" : document.scope === "index" ? "INDEX ↔ HEAD" : "WORKING TREE ↔ INDEX"}</span><strong>{document.path}</strong>{document.originalPath && <small>{document.originalPath} → {document.path}</small>}</div>
      <div className="splitDiffColumns" aria-hidden="true"><div /><div>OLD</div><div>NEW</div></div>
      {document.hunks.map((hunk, hunkIndex) => {
        const changeRowIndexes = hunk.rows.flatMap((row, rowIndex) => row.kind === "change" ? [rowIndex] : []);
        const hunkSelected = selection.some((item) => item.hunkIndex === hunkIndex && item.rowIndex === undefined);
        const allRowsSelected = changeRowIndexes.length > 0 && changeRowIndexes.every((rowIndex) => selection.some((item) => item.hunkIndex === hunkIndex && (item.rowIndex === undefined || item.rowIndex === rowIndex)));
        return (
        <section className="splitDiffHunk" key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`} aria-label={`Change hunk ${hunkIndex + 1}`}>
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
          </div>
          {hunk.rows.map((row, rowIndex) => (
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
              <div className="splitDiffCell"><span className="splitDiffLineNumber">{row.oldLine ?? ""}</span><code>{row.oldText ?? ""}</code></div>
              <div className="splitDiffCell"><span className="splitDiffLineNumber">{row.newLine ?? ""}</span><code>{row.newText ?? ""}</code></div>
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
