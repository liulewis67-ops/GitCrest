import { useEffect, useRef, useState } from "react";
import type { AiFileSelection, AiReplyResponse, AiSettingsResponse, CommitRequest, DiffDocumentResponse, GitCrestApiClient, StatusSnapshotResponse } from "../../../api/client";

type CommitSelection = NonNullable<CommitRequest["selections"]>[number];
type ReviewedFile = { path: string; document: DiffDocumentResponse; selections?: CommitSelection["selections"] };

const PROMPT = "Write a concise Conventional Commit message for the reviewed staged changes. Return only the commit subject and optional body. Do not use Markdown fences. Do not claim unreviewed changes.";
const SUMMARY_PROMPT = "Summarize the reviewed staged changes in concise bullet points. Mention key behavior changes and important risks visible from the diff. Do not claim unreviewed changes. Return plain text.";

function statusFingerprint(snapshot: StatusSnapshotResponse): string {
  return JSON.stringify(snapshot.files.map(({ path, indexStatus, worktreeStatus, kind, categories, modeChanged }) => ({ path, indexStatus, worktreeStatus, kind, categories: [...categories].sort(), modeChanged })));
}

function selectedRows(document: DiffDocumentResponse, selections: NonNullable<CommitSelection["selections"]>): string {
  const picked = new Map<number, Set<number>>();
  for (const selection of selections) {
    const hunk = document.hunks[selection.hunkIndex];
    if (!hunk) throw new Error("A staged selection is no longer available. Refresh the diff and select the changes again.");
    const rows = selection.rowIndex === undefined
      ? hunk.rows.map((row, index) => row.kind === "change" ? index : -1).filter((index) => index >= 0)
      : [selection.rowIndex];
    for (const rowIndex of rows) {
      const row = hunk.rows[rowIndex];
      if (!row || row.kind !== "change") throw new Error("A staged selection is no longer available. Refresh the diff and select the changes again.");
      const indices = picked.get(selection.hunkIndex) || new Set<number>();
      indices.add(rowIndex);
      picked.set(selection.hunkIndex, indices);
    }
  }
  const output: string[] = [];
  for (const [hunkIndex, indices] of picked) {
    const hunk = document.hunks[hunkIndex];
    output.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const rowIndex of [...indices].sort((left, right) => left - right)) {
      const row = hunk.rows[rowIndex];
      if (row.oldText !== null) output.push(`-${row.oldText}`);
      if (row.newText !== null) output.push(`+${row.newText}`);
    }
  }
  return output.join("\n");
}

function diffText(document: DiffDocumentResponse, selections?: NonNullable<CommitSelection["selections"]>): string {
  if (selections) return selectedRows(document, selections);
  return document.hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.rows.flatMap((row) => row.kind === "context"
      ? [` ${row.oldText ?? row.newText ?? ""}`]
      : [...(row.oldText !== null ? [`-${row.oldText}`] : []), ...(row.newText !== null ? [`+${row.newText}`] : [])]),
  ]).join("\n");
}

function stagedPaths(snapshot: StatusSnapshotResponse): string[] {
  return snapshot.files
    .filter((file) => file.categories.includes("staged") && !file.categories.includes("conflicted") && !file.categories.includes("ignored"))
    .map((file) => file.path)
    .sort();
}

export function CommitMessageAssistant({
  api,
  repoId,
  draftMessage,
  commitSelections,
  commitSelectionRepoId,
  statusSnapshot,
  onUseSuggestion,
  onClose,
}: {
  api: GitCrestApiClient;
  repoId: string;
  draftMessage: string;
  commitSelections: NonNullable<CommitRequest["selections"]>;
  commitSelectionRepoId?: string;
  statusSnapshot?: StatusSnapshotResponse;
  onUseSuggestion: (message: string) => void;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<AiSettingsResponse>();
  const [reviewed, setReviewed] = useState<ReviewedFile[]>([]);
  const [reviewFingerprint, setReviewFingerprint] = useState("");
  const [reviewDiffBytes, setReviewDiffBytes] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [suggestion, setSuggestion] = useState<AiReplyResponse>();
  const [summaryResult, setSummaryResult] = useState<AiReplyResponse>();
  const [suggestionText, setSuggestionText] = useState("");
  const [outputMode, setOutputMode] = useState<"commitMessage" | "changeSummary">("commitMessage");
  const [requestDraft, setRequestDraft] = useState("");
  const [draftChanged, setDraftChanged] = useState(false);
  const [workspaceStale, setWorkspaceStale] = useState(false);
  const draftRef = useRef(draftMessage);
  draftRef.current = draftMessage;

  useEffect(() => {
    if (suggestion && draftMessage !== requestDraft) setDraftChanged(true);
  }, [draftMessage, requestDraft, suggestion]);

  useEffect(() => {
    if (!statusSnapshot || reviewed.length === 0 || !reviewFingerprint) return;
    if (statusFingerprint(statusSnapshot) !== reviewFingerprint) {
      setWorkspaceStale(true);
      return;
    }
    let current = true;
    void checkFresh(reviewed, reviewFingerprint).then((fresh) => {
      if (current && !fresh) setWorkspaceStale(true);
    }).catch(() => { if (current) setWorkspaceStale(true); });
    return () => { current = false; };
    // Snapshot identity changes only after the workspace has been explicitly refreshed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusSnapshot]);

  useEffect(() => {
    let current = true;
    void api.getAiSettings().then((value) => { if (current) setSettings(value); }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "AI provider settings could not be loaded.");
    });
    void reviewCurrentChanges();
    return () => { current = false; };
    // This panel is a per-repository request session. Refresh is explicit after opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, repoId]);

  async function reviewCurrentChanges() {
    setBusy(true); setError(""); setReviewed([]); setSuggestion(undefined); setSummaryResult(undefined); setSuggestionText("");
    setConfirmed(false); setWorkspaceStale(false); setDraftChanged(false);
    try {
      const snapshot = await api.getRepositoryStatus(repoId);
      const paths = commitSelections.length > 0
        ? commitSelectionRepoId === repoId ? [...new Set(commitSelections.map(({ path }) => path))].sort() : []
        : stagedPaths(snapshot);
      if (paths.length === 0) throw new Error("Stage changes before generating a commit suggestion.");
      if (paths.length > 20) throw new Error("A commit suggestion can include at most 20 staged file scopes. Select fewer staged changes.");
      const currentStaged = new Set(stagedPaths(snapshot));
      const documents: ReviewedFile[] = [];
      let bytes = 0;
      for (const path of paths) {
        if (!currentStaged.has(path)) throw new Error(`${path} is no longer staged. Refresh status and review the commit scope again.`);
        const document = await api.getFileDiff(repoId, path, "index");
        if (document.status !== "text") throw new Error(`${path} is ${document.status} and cannot be sent as text.`);
        const selected = commitSelections.length > 0 ? commitSelections.find((item) => item.path === path) : undefined;
        if (commitSelections.length > 0 && !selected) throw new Error("The selected commit scope changed. Select the staged changes again.");
        if (selected && selected.revision !== document.revision) throw new Error(`${path} changed after its staged commit selection was reviewed. Refresh the diff and select the changes again.`);
        const file: ReviewedFile = { path, document, ...(selected ? { selections: selected.selections } : {}) };
        bytes += new TextEncoder().encode(diffText(document, file.selections)).length;
        if (bytes > 1024 * 1024) throw new Error("The selected staged diffs exceed the 1 MiB request limit. Select fewer changes.");
        documents.push(file);
      }
      if (commitSelections.length > 0 && paths.length !== commitSelections.length) throw new Error("The staged commit selection contains duplicate paths. Clear it and select the changes again.");
      setReviewed(documents); setReviewFingerprint(statusFingerprint(snapshot)); setReviewDiffBytes(bytes);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The staged changes could not be reviewed.");
    } finally { setBusy(false); }
  }

  async function checkFresh(files: ReviewedFile[], fingerprint: string): Promise<boolean> {
    const snapshot = await api.getRepositoryStatus(repoId);
    if (statusFingerprint(snapshot) !== fingerprint) return false;
    for (const file of files) {
      const current = await api.getFileDiff(repoId, file.path, "index");
      if (current.revision !== file.document.revision || current.status !== "text") return false;
    }
    return true;
  }

  async function sendReviewed() {
    if (!settings || settings.provider === "none" || !confirmed || reviewed.length === 0 || busy) return;
    const requestMode = outputMode;
    const prompt = requestMode === "changeSummary" ? SUMMARY_PROMPT : PROMPT;
    const baselineDraft = draftRef.current;
    setRequestDraft(baselineDraft);
    setBusy(true); setError(""); setSuggestion(undefined); setSummaryResult(undefined); setSuggestionText("");
    try {
      if (!(await checkFresh(reviewed, reviewFingerprint))) {
        setWorkspaceStale(true);
        throw new Error("Staged changes changed after review. Review them again before sending.");
      }
      const files: AiFileSelection[] = reviewed.map((file) => ({
        path: file.path,
        scope: "index",
        revision: file.document.revision,
        ...(file.selections ? { selections: file.selections } : {}),
      }));
      const result = await api.requestAiReview(repoId, prompt, files);
      const [freshWorkspace, draftStillMatches] = await Promise.all([
        checkFresh(reviewed, reviewFingerprint),
        Promise.resolve(draftRef.current === baselineDraft),
      ]);
      if (requestMode === "changeSummary") setSummaryResult(result);
      else { setSuggestion(result); setSuggestionText(result.response); }
      setWorkspaceStale(!freshWorkspace);
      setDraftChanged(!draftStillMatches);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The AI provider request failed. You can retry or keep writing the commit manually.");
      setConfirmed(false);
    } finally { setBusy(false); }
  }

  const canUseSuggestion = Boolean(suggestion && suggestionText.trim() && !busy && !workspaceStale && !draftChanged && draftRef.current === requestDraft);

  return (
    <section className="commitAiAssistant" aria-labelledby="commit-ai-title">
      <div className="commitAiHeader"><h4 id="commit-ai-title">AI commit message suggestion</h4><button className="textButton" type="button" onClick={onClose}>Close</button></div>
      <p className="settingsNotice">The provider receives only the reviewed staged diff. Responses stay separate from the commit message unless you explicitly use a commit suggestion. Manual commit remains available.</p>
      <label className="commitAiOutputMode">AI output<select aria-label="AI output" value={outputMode} disabled={busy} onChange={(event) => { setOutputMode(event.target.value as typeof outputMode); setSuggestion(undefined); setSummaryResult(undefined); setSuggestionText(""); setConfirmed(false); setDraftChanged(false); }}><option value="commitMessage">Conventional commit message</option><option value="changeSummary">Change summary</option></select></label>
      {busy && reviewed.length === 0 && <p role="status">Loading staged changes for review…</p>}
      {settings?.provider === "none" && <p className="settingsNotice">Choose an AI provider in Settings before sending a request.</p>}
      {settings?.provider === "openAiCompatible" && !settings.hasCloudCredential && <p className="settingsNotice">Save a cloud API key in Settings before sending a request.</p>}
      {reviewed.length > 0 && <>
        <div className="commitAiRequestDetails">
          <p><strong>Provider endpoint:</strong> {settings?.baseUrl || (settings?.provider === "ollama" ? "Loopback Ollama endpoint" : "Loading provider settings…")}</p>
          <p><strong>Prompt:</strong> {outputMode === "changeSummary" ? SUMMARY_PROMPT : PROMPT}</p>
          <p><strong>Scope:</strong> {reviewed.length} staged file scope{reviewed.length === 1 ? "" : "s"} · {(reviewDiffBytes / 1024).toFixed(1)} KiB</p>
        </div>
        {reviewed.map((file) => <details className="privacyDiffPreview" key={file.path} open>
          <summary>{file.path} · staged/index · {file.selections ? `${file.selections.length} selected hunk/row range${file.selections.length === 1 ? "" : "s"}` : "all staged changes"}</summary>
          <pre>{diffText(file.document, file.selections) || "The reviewed staged diff is empty."}</pre>
        </details>)}
        {workspaceStale && <p role="alert" className="taskCenterError">Staged changes changed. Review the current staged changes again.</p>}
        {suggestion && workspaceStale && <p role="status">This suggestion is stale and cannot be applied.</p>}
        {suggestion && draftChanged && <p role="status">The commit draft changed while the provider was responding. Your text was kept; start a new request to use a suggestion.</p>}
        {!suggestion && !summaryResult && <label className="aiRequestConsent"><input type="checkbox" checked={confirmed} disabled={busy || workspaceStale} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the staged diff, prompt, and provider endpoint and want to send them.</label>}
        {suggestion && <>
          <label className="commitAiSuggestion">Suggestion from {suggestion.provider} · {suggestion.model}<textarea aria-label="Commit message suggestion" value={suggestionText} disabled={busy} onChange={(event) => setSuggestionText(event.target.value)} /></label>
          <div className="commitAiActions">
            <button type="button" className="secondaryButton" disabled={busy} onClick={() => void reviewCurrentChanges()}>Review current staged changes again</button>
            <button type="button" className="primaryButton" disabled={!canUseSuggestion} onClick={() => { if (canUseSuggestion) onUseSuggestion(suggestionText); }}>Use suggestion</button>
          </div>
        </>}
        {summaryResult && <section className="commitAiSummary" aria-label="AI change summary"><h5>Change summary · {summaryResult.model}</h5><pre>{summaryResult.response}</pre><button type="button" className="secondaryButton" disabled={busy} onClick={() => void reviewCurrentChanges()}>Review current staged changes again</button></section>}
        {!suggestion && !summaryResult && <button type="button" className="primaryButton" disabled={!confirmed || busy || settings?.provider === "none" || !settings || (settings.provider === "openAiCompatible" && !settings.hasCloudCredential)} onClick={() => void sendReviewed()}>{busy ? "Waiting for provider…" : outputMode === "changeSummary" ? "Summarize reviewed staged diff" : "Send reviewed staged diff"}</button>}
      </>}
      {error && <div className="commitAiError" role="alert"><span>{error}</span><button type="button" className="secondaryButton" disabled={busy} onClick={() => void reviewCurrentChanges()}>Review and retry</button></div>}
    </section>
  );
}
