import { Fragment, useEffect, useMemo, useState } from "react";
import { GitCrestApiClient, type DiffDocumentResponse } from "../../api/client";
import { SplitDiff } from "./SplitDiff";
import "../../App.css";

type View = "split" | "unified";

export function DiffWindow() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const repoId = params.get("repoId") || "";
  const path = params.get("path") || "";
  const scope = params.get("scope");
  const commitOid = params.get("commitOid") || undefined;
  const [document, setDocument] = useState<DiffDocumentResponse>();
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("split");

  useEffect(() => {
    let active = true;
    if (!repoId || !path || !["workingTree", "index", "commit"].includes(scope || "")) {
      setError("This Diff window request is invalid. Reopen the file from GitCrest.");
      return () => { active = false; };
    }
    void window.gitcrest.getSidecarConnection().then((connection) => {
      if (connection.windowAccess !== "readOnly") throw new Error("Diff windows must use read-only access.");
      const api = new GitCrestApiClient(connection.baseUrl, connection.token);
      return scope === "commit" && commitOid
        ? api.getRepositoryCommitDiff(repoId, commitOid, path)
          : scope === "workingTree" || scope === "index"
          ? api.getFileDiff(repoId, path, scope)
          : Promise.reject(new Error("A commit ID is required for a historical Diff."));
    }).then((result) => {
      if (active) setDocument(result);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load this file diff.");
    });
    return () => { active = false; };
  }, [commitOid, path, repoId, scope]);

  return (
    <main className="diffWindow" aria-label="Read-only Diff window">
      <header className="diffWindowHeader">
        <div><span className="sectionEyebrow">READ ONLY DIFF</span><strong title={path}>{path || "File diff"}</strong></div>
        <div className="diffWindowViewToggle" role="group" aria-label="Diff layout">
          <button type="button" aria-pressed={view === "split"} onClick={() => setView("split")}>Split</button>
          <button type="button" aria-pressed={view === "unified"} onClick={() => setView("unified")}>Unified</button>
        </div>
      </header>
      <section className="diffWindowContent" aria-label="File diff content">
        {error ? <div className="diffSpecialState" role="alert"><p>{error}</p></div>
          : !document ? <div className="diffSpecialState" role="status">Loading file diff…</div>
            : view === "split"
              ? <SplitDiff document={document} onStageSelection={() => undefined} disabled readOnly />
              : <UnifiedDiff document={document} />}
      </section>
    </main>
  );
}

function UnifiedDiff({ document }: { document: DiffDocumentResponse }) {
  if (document.status !== "text") {
    return <div className="diffSpecialState" role="status"><span className={`diffStateBadge diffState-${document.status}`}>{document.status}</span><p>{document.status === "binary" ? "This file is binary; Git does not provide a line based diff." : "No text diff is available for this file."}</p></div>;
  }
  return <div className="unifiedDiff" aria-label={`Unified diff for ${document.path}`}>
    <div className="splitDiffFileMeta"><span className="diffScopeBadge">{document.scope === "commit" ? "COMMIT ↔ FIRST PARENT" : document.scope === "index" ? "INDEX ↔ HEAD" : "WORKING TREE ↔ INDEX"}</span><strong>{document.path}</strong></div>
    {document.hunks.map((hunk, hunkIndex) => <section className="unifiedDiffHunk" aria-label={`Change hunk ${hunkIndex + 1}`} key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
      <header>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</header>
      {hunk.rows.map((row, rowIndex) => row.kind === "context"
        ? <div className="unifiedDiffRow" key={rowIndex}><span>{row.oldLine ?? ""}</span><span>{row.newLine ?? ""}</span><code> {row.oldText ?? row.newText ?? ""}</code></div>
        : <Fragment key={rowIndex}>
          {row.oldText !== null && row.oldText !== undefined && <div className="unifiedDiffRow unifiedDiffDeletion"><span>{row.oldLine ?? ""}</span><span /> <code>-{row.oldText}</code></div>}
          {row.newText !== null && row.newText !== undefined && <div className="unifiedDiffRow unifiedDiffAddition"><span /> <span>{row.newLine ?? ""}</span><code>+{row.newText}</code></div>}
        </Fragment>)}
    </section>)}
  </div>;
}
