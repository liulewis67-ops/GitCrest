import { useEffect, useMemo, useRef, useState } from "react";
import type { AiReplyResponse, AiSettingsResponse, DiffDocumentResponse, GitCrestApiClient, StatusSnapshotResponse } from "../../../api/client";

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

export function PrivacyScopePreview({ api, repoId, settings }: { api: GitCrestApiClient; repoId?: string; settings?: AiSettingsResponse }) {
  const [status, setStatus] = useState<StatusSnapshotResponse>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedDiff, setSelectedDiff] = useState<Candidate>();
  const [document, setDocument] = useState<DiffDocumentResponse>();
  const [loading, setLoading] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewed, setReviewed] = useState<Array<{ candidate: Candidate; document: DiffDocumentResponse }>>([]);
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [prompt, setPrompt] = useState("Summarize the selected changes and note any risks.");
  const [requestBusy, setRequestBusy] = useState(false);
  const [reply, setReply] = useState<AiReplyResponse>();
  const [error, setError] = useState("");
  const diffRequest = useRef(0);
  const reviewAttempt = useRef(0);
  const diffController = useRef<AbortController>();
  const reviewController = useRef<AbortController>();

  useEffect(() => {
    const controller = new AbortController();
    diffRequest.current += 1;
    reviewAttempt.current += 1;
    setStatus(undefined); setSelectedIds([]); setSelectedDiff(undefined); setDocument(undefined); setError("");
    setLoading(false); setReviewBusy(false); setReviewed([]); setConfirmSend(false); setConfirmed(false); setReply(undefined);
    if (!repoId) return () => controller.abort();
    void api.withSignal(controller.signal).getRepositoryStatus(repoId).then((snapshot) => {
      if (!controller.signal.aborted) setStatus(snapshot);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Changed files could not be loaded.");
    });
    return () => {
      controller.abort();
      diffController.current?.abort();
      reviewController.current?.abort();
    };
  }, [api, repoId]);

  useEffect(() => {
    setConfirmed(false);
    setReply(undefined);
  }, [settings?.provider, settings?.baseUrl, settings?.model]);

  const candidates = useMemo(() => status ? candidatesFromStatus(status) : [], [status]);
  const visibleCandidates = candidates.slice(0, 200);
  const omittedCandidateCount = Math.max(0, candidates.length - visibleCandidates.length);
  const selected = visibleCandidates.filter((candidate) => selectedIds.includes(candidate.id));

  function toggle(candidate: Candidate) {
    reviewAttempt.current += 1;
    reviewController.current?.abort();
    reviewController.current = undefined;
    setReviewBusy(false);
    setReviewed([]); setConfirmSend(false); setConfirmed(false); setReply(undefined);
    setSelectedIds((ids) => ids.includes(candidate.id) ? ids.filter((id) => id !== candidate.id) : [...ids, candidate.id]);
    if (selectedDiff?.id === candidate.id) {
      diffRequest.current += 1;
      diffController.current?.abort();
      diffController.current = undefined;
      setSelectedDiff(undefined); setDocument(undefined); setLoading(false);
    }
  }

  async function showDiff(candidate: Candidate) {
    if (!repoId) return;
    diffController.current?.abort();
    const controller = new AbortController();
    diffController.current = controller;
    const requestId = ++diffRequest.current;
    setSelectedDiff(candidate); setDocument(undefined); setError(""); setLoading(true);
    try {
      const result = await api.withSignal(controller.signal).getFileDiff(repoId, candidate.path, candidate.scope);
      if (!controller.signal.aborted && diffRequest.current === requestId) setDocument(result);
    } catch (reason) {
      if (!controller.signal.aborted && diffRequest.current === requestId) setError(reason instanceof Error ? reason.message : "The selected diff could not be previewed.");
    } finally {
      if (diffController.current === controller) diffController.current = undefined;
      if (!controller.signal.aborted && diffRequest.current === requestId) setLoading(false);
    }
  }

  async function reviewSelected() {
    if (!repoId || selected.length === 0 || selected.length > 20) return;
    reviewController.current?.abort();
    const controller = new AbortController();
    reviewController.current = controller;
    const attempt = ++reviewAttempt.current;
    setReviewBusy(true); setError(""); setReviewed([]); setConfirmSend(false); setConfirmed(false); setReply(undefined);
    try {
      const documents: Array<{ candidate: Candidate; document: DiffDocumentResponse }> = [];
      let byteCount = 0;
      for (const candidate of selected) {
        const document = await api.withSignal(controller.signal).getFileDiff(repoId, candidate.path, candidate.scope);
        if (document.status !== "text") throw new Error(`${candidate.path} is ${document.status} and cannot be sent as text.`);
        byteCount += new TextEncoder().encode(diffText(document)).length;
        if (byteCount > 1024 * 1024) throw new Error("The selected text diffs exceed the 1 MiB request limit. Remove files and review again.");
        documents.push({ candidate, document });
      }
      if (!controller.signal.aborted && reviewAttempt.current === attempt) {
        setReviewed(documents);
        setConfirmSend(true);
      }
    } catch (reason) {
      if (!controller.signal.aborted && reviewAttempt.current === attempt) setError(reason instanceof Error ? reason.message : "Selected diffs could not be prepared for review.");
    } finally {
      if (reviewController.current === controller) reviewController.current = undefined;
      if (!controller.signal.aborted && reviewAttempt.current === attempt) setReviewBusy(false);
    }
  }

  async function sendReviewedDiffs() {
    if (!repoId || !settings || settings.provider === "none" || !confirmed || reviewed.length !== selected.length) return;
    setRequestBusy(true); setError(""); setReply(undefined);
    try {
      const result = await api.requestAiReview(repoId, prompt, reviewed.map(({ candidate, document }) => ({
        path: candidate.path,
        scope: candidate.scope,
        revision: document.revision,
      })));
      setReply(result); setConfirmSend(false); setConfirmed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The AI provider request failed.");
      setReviewed([]); setConfirmSend(false); setConfirmed(false);
    } finally { setRequestBusy(false); }
  }

  return (
    <section className="privacyScope" aria-labelledby="privacy-scope-title">
      <div className="privacyScopeHeader"><div><h3 id="privacy-scope-title">Review files and diff scope</h3><p>Select the exact staged/index or unstaged/worktree changes to include. Nothing is sent until you review all selected diffs and confirm.</p></div><span className="privacyScopeCount" aria-live="polite">{selected.length} selected</span></div>
      {!repoId ? <p className="settingsNotice">Open a repository and select it in Workspace to review changed files.</p> : !status && !error ? <p className="settingsNotice" role="status">Loading changed files…</p> : null}
      {status && candidates.length === 0 && <p className="settingsNotice">No staged or unstaged text changes are available to review.</p>}
      {status && candidates.length > 0 && <ul className="privacyScopeList">
        {visibleCandidates.map((candidate) => {
          const included = selectedIds.includes(candidate.id);
          return <li key={candidate.id}>
            <label><input type="checkbox" checked={included} disabled={requestBusy || reviewBusy} onChange={() => toggle(candidate)} /><span className="privacyScopePath">{candidate.path}</span><span className="privacyScopeScope">{candidate.scope === "index" ? "Staged · index" : "Unstaged · worktree"}</span></label>
            {included && <button type="button" className="textButton" disabled={requestBusy || reviewBusy} onClick={() => void showDiff(candidate)}>Preview diff</button>}
          </li>;
        })}
      </ul>}
      {omittedCandidateCount > 0 && <p className="settingsNotice">Showing the first 200 file/scope pairs; {omittedCandidateCount} more are omitted from this preview.</p>}
      {selected.length > 0 && <p className="privacyScopeSummary">A provider request will be limited to {selected.length} selected file/scope pair{selected.length === 1 ? "" : "s"}. Inspect each diff before confirming.</p>}
      {selected.length > 0 && settings?.provider === "none" && <p className="settingsNotice">Choose and save a provider above before sending a request.</p>}
      {selected.length > 0 && settings?.provider === "openAiCompatible" && !settings.hasCloudCredential && <p className="settingsNotice">Save a cloud API key above before sending a request.</p>}
      {selected.length > 0 && <button type="button" className="secondaryButton" disabled={reviewBusy || selected.length > 20 || !settings || settings.provider === "none" || (settings.provider === "openAiCompatible" && !settings.hasCloudCredential)} onClick={() => void reviewSelected()}>{reviewBusy ? "Loading selected diffs…" : "Review all selected diffs before sending"}</button>}
      {selected.length > 20 && <p className="taskCenterError" role="alert">A request can contain at most 20 file/scope pairs.</p>}
      {selectedDiff && <section className="privacyDiffPreview" aria-label={`Diff preview for ${selectedDiff.path}`}>
        <header><strong>{selectedDiff.path}</strong><span>{selectedDiff.scope === "index" ? "Index" : "Working tree"}</span></header>
        {loading ? <p role="status">Loading diff…</p> : document?.status === "binary" ? <p>Binary file: no text diff will be included.</p> : document?.status !== "text" ? <p>{document ? `This ${document.status} diff is not available for AI preview.` : ""}</p> : <pre>{diffText(document) || "The selected diff is empty."}</pre>}
      </section>}
      {confirmSend && reviewed.length > 0 && <section className="aiRequestReview" aria-labelledby="ai-request-review-title">
        <h4 id="ai-request-review-title">Confirm provider request</h4>
        <p>{settings?.provider === "openAiCompatible" ? `These exact diffs will be sent to the cloud endpoint ${settings.baseUrl}.` : "These exact diffs will be sent to the configured loopback Ollama endpoint on this machine."}</p>
        <label>Prompt<textarea aria-label="AI review prompt" disabled={requestBusy} maxLength={2048} value={prompt} onChange={(event) => { setPrompt(event.target.value); setConfirmed(false); }} /></label>
        {reviewed.map(({ candidate, document }) => <details className="privacyDiffPreview" key={candidate.id} open>
          <summary>{candidate.path} · {candidate.scope === "index" ? "Index" : "Working tree"} · {document.hunks.reduce((count, hunk) => count + hunk.rows.length, 0)} diff rows</summary>
          <pre>{diffText(document)}</pre>
        </details>)}
        <label className="aiRequestConsent"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the files and diffs above and want to send them to this provider.</label>
        <button type="button" className="primaryButton" disabled={!confirmed || !prompt.trim() || requestBusy || settings?.provider === "none" || (settings?.provider === "openAiCompatible" && !settings.hasCloudCredential)} onClick={() => void sendReviewedDiffs()}>{requestBusy ? "Waiting for provider…" : "Send these exact diffs"}</button>
      </section>}
      {reply && <section className="aiReply" aria-labelledby="ai-reply-title"><h4 id="ai-reply-title">Provider response · {reply.model}</h4><p>Sent file scopes: {reply.files.join(", ")}</p><pre>{reply.response}</pre></section>}
      {error && <p className="taskCenterError" role="alert">{error}</p>}
    </section>
  );
}
