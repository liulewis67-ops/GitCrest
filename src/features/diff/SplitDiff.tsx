import type { DiffDocumentResponse } from "../../api/client";

interface SplitDiffProps {
  document: DiffDocumentResponse;
}

export function SplitDiff({ document }: SplitDiffProps) {
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
      <div className="splitDiffFileMeta"><span className="diffScopeBadge">{document.scope === "index" ? "INDEX ↔ HEAD" : "WORKING TREE ↔ INDEX"}</span><strong>{document.path}</strong>{document.originalPath && <small>{document.originalPath} → {document.path}</small>}</div>
      <div className="splitDiffColumns" aria-hidden="true"><div>OLD</div><div>NEW</div></div>
      {document.hunks.map((hunk, hunkIndex) => (
        <section className="splitDiffHunk" key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`} aria-label={`Change hunk ${hunkIndex + 1}`}>
          <div className="splitDiffHunkHeader">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
          {hunk.rows.map((row, rowIndex) => (
            <div className={`splitDiffRow splitDiffRow-${row.kind}`} key={`${hunkIndex}:${rowIndex}`}>
              <div className="splitDiffCell"><span className="splitDiffLineNumber">{row.oldLine ?? ""}</span><code>{row.oldText ?? ""}</code></div>
              <div className="splitDiffCell"><span className="splitDiffLineNumber">{row.newLine ?? ""}</span><code>{row.newText ?? ""}</code></div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
