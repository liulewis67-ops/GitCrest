import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffDocumentResponse, GitCrestApiClient, StatusSnapshotResponse } from "../../api/client";

type Candidate = { id: string; path: string; scope: "workingTree" | "index" };

function candidatesFromStatus(snapshot: StatusSnapshotResponse): Candidate[] {
  return snapshot.files.flatMap((file) => {
    if (file.categories.includes("conflicted") || file.categories.includes("ignored")) return [];
    const scopes: Candidate["scope"][] = [];
    if (file.categories.includes("staged")) scopes.push("index");
    if (file.categories.includes("unstaged") || file.categories.includes("untracked")) scopes.push("workingTree");
    return scopes.map((scope) => ({ id: `${scope}:${file.path}`, path: file.path, scope }));
  });
}

function diffText(document: DiffDocumentResponse): string {
  return document.hunks.flatMap((hunk) => hunk.rows.flatMap((row) => {
    if (row.kind === "context") return [` ${row.oldText ?? row.newText ?? ""}`];
    return [
      ...(row.oldText !== null ? [`-${row.oldText}`] : []),
      ...(row.newText !== null ? [`+${row.newText}`] : []),
    ];
  })).join("\n");
}

export function PrivacyScopePreview({ api, repoId }: { api: GitCrestApiClient; repoId?: string }) {
  const [status, setStatus] = useState<StatusSnapshotResponse>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedDiff, setSelectedDiff] = useState<Candidate>();
  const [document, setDocument] = useState<DiffDocumentResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const diffRequest = useRef(0);

  useEffect(() => {
    let current = true;
    diffRequest.current += 1;
    setStatus(undefined); setSelectedIds([]); setSelectedDiff(undefined); setDocument(undefined); setError("");
    if (!repoId) return () => { current = false; };
    void api.getRepositoryStatus(repoId).then((snapshot) => {
      if (current) setStatus(snapshot);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "Changed files could not be loaded.");
    });
    return () => { current = false; };
  }, [api, repoId]);

  const candidates = useMemo(() => status ? candidatesFromStatus(status) : [], [status]);
  const visibleCandidates = candidates.slice(0, 200);
  const omittedCandidateCount = Math.max(0, candidates.length - visibleCandidates.length);
  const selected = visibleCandidates.filter((candidate) => selectedIds.includes(candidate.id));

  function toggle(candidate: Candidate) {
    diffRequest.current += 1;
    setSelectedIds((ids) => ids.includes(candidate.id) ? ids.filter((id) => id !== candidate.id) : [...ids, candidate.id]);
    if (selectedDiff?.id === candidate.id) { setSelectedDiff(undefined); setDocument(undefined); }
  }

  async function showDiff(candidate: Candidate) {
    if (!repoId) return;
    const requestId = ++diffRequest.current;
    setSelectedDiff(candidate); setDocument(undefined); setError(""); setLoading(true);
    try {
      const result = await api.getFileDiff(repoId, candidate.path, candidate.scope);
      if (diffRequest.current === requestId) setDocument(result);
    } catch (reason) {
      if (diffRequest.current === requestId) setError(reason instanceof Error ? reason.message : "The selected diff could not be previewed.");
    } finally { if (diffRequest.current === requestId) setLoading(false); }
  }

  return (
    <section className="privacyScope" aria-labelledby="privacy-scope-title">
      <div className="privacyScopeHeader"><div><h3 id="privacy-scope-title">Review files and diff scope</h3><p>This list stays in GitCrest. Select each file and index/worktree scope that a future AI request may use.</p></div><span className="privacyScopeCount" aria-live="polite">{selected.length} selected</span></div>
      {!repoId ? <p className="settingsNotice">Open a repository and select it in Workspace to review changed files.</p> : !status && !error ? <p className="settingsNotice" role="status">Loading changed files…</p> : null}
      {status && candidates.length === 0 && <p className="settingsNotice">No staged or unstaged text changes are available to review.</p>}
      {status && candidates.length > 0 && <ul className="privacyScopeList">
        {visibleCandidates.map((candidate) => {
          const included = selectedIds.includes(candidate.id);
          return <li key={candidate.id}>
            <label><input type="checkbox" checked={included} onChange={() => toggle(candidate)} /><span className="privacyScopePath">{candidate.path}</span><span className="privacyScopeScope">{candidate.scope === "index" ? "Staged · index" : "Unstaged · worktree"}</span></label>
            {included && <button type="button" className="textButton" onClick={() => void showDiff(candidate)}>Preview diff</button>}
          </li>;
        })}
      </ul>}
      {omittedCandidateCount > 0 && <p className="settingsNotice">Showing the first 200 file/scope pairs; {omittedCandidateCount} more are omitted from this preview.</p>}
      {selected.length > 0 && <p className="privacyScopeSummary">A future request would be limited to {selected.length} selected file/scope pair{selected.length === 1 ? "" : "s"}. No provider request is made here.</p>}
      {selectedDiff && <section className="privacyDiffPreview" aria-label={`Diff preview for ${selectedDiff.path}`}>
        <header><strong>{selectedDiff.path}</strong><span>{selectedDiff.scope === "index" ? "Index" : "Working tree"}</span></header>
        {loading ? <p role="status">Loading diff…</p> : document?.status === "binary" ? <p>Binary file: no text diff will be included.</p> : document?.status !== "text" ? <p>{document ? `This ${document.status} diff is not available for AI preview.` : ""}</p> : <pre>{diffText(document) || "The selected diff is empty."}</pre>}
      </section>}
      {error && <p className="taskCenterError" role="alert">{error}</p>}
    </section>
  );
}
