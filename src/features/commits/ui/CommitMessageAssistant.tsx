import { t } from "../../../shared/i18n";
import { useI18n } from "../../../shared/i18n";
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
  // Each picked row with the side that was selected; `undefined` is the whole row.
  const picked = new Map<number, Map<number, "old" | "new" | undefined>>();
  for (const selection of selections) {
    const hunk = document.hunks[selection.hunkIndex];
    if (!hunk) throw new Error(t("ai.selectionGone"));
    const rows = selection.rowIndex === undefined
      ? hunk.rows.map((row, index) => row.kind === "change" ? index : -1).filter((index) => index >= 0)
      : [selection.rowIndex];
    for (const rowIndex of rows) {
      const row = hunk.rows[rowIndex];
      if (!row || row.kind !== "change") throw new Error(t("ai.selectionGone"));
      const indices = picked.get(selection.hunkIndex) || new Map<number, "old" | "new" | undefined>();
      const side = selection.side;
      indices.set(rowIndex, indices.has(rowIndex) && indices.get(rowIndex) !== side ? undefined : side);
      picked.set(selection.hunkIndex, indices);
    }
  }
  const output: string[] = [];
  for (const [hunkIndex, indices] of picked) {
    const hunk = document.hunks[hunkIndex];
    output.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const rowIndex of [...indices.keys()].sort((left, right) => left - right)) {
      const row = hunk.rows[rowIndex];
      const side = indices.get(rowIndex);
      if (row.oldText !== null && side !== "new") output.push(`-${row.oldText}`);
      if (row.newText !== null && side !== "old") output.push(`+${row.newText}`);
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
  const { t } = useI18n();
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
      if (current) setError(reason instanceof Error ? reason.message : t("ai.settingsLoadFailed"));
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
      if (paths.length === 0) throw new Error(t("ai.stageFirst"));
      if (paths.length > 20) throw new Error(t("ai.tooMany"));
      const currentStaged = new Set(stagedPaths(snapshot));
      const documents: ReviewedFile[] = [];
      let bytes = 0;
      for (const path of paths) {
        if (!currentStaged.has(path)) throw new Error(t("ai.noLongerStaged", { path }));
        const document = await api.getFileDiff(repoId, path, "index");
        if (document.status !== "text") throw new Error(t("ai.cannotSend", { path, status: document.status }));
        const selected = commitSelections.length > 0 ? commitSelections.find((item) => item.path === path) : undefined;
        if (commitSelections.length > 0 && !selected) throw new Error(t("ai.scopeChanged"));
        if (selected && selected.revision !== document.revision) throw new Error(t("ai.selChanged", { path }));
        const file: ReviewedFile = { path, document, ...(selected ? { selections: selected.selections } : {}) };
        bytes += new TextEncoder().encode(diffText(document, file.selections)).length;
        if (bytes > 1024 * 1024) throw new Error(t("ai.tooBig"));
        documents.push(file);
      }
      if (commitSelections.length > 0 && paths.length !== commitSelections.length) throw new Error(t("ai.duplicate"));
      setReviewed(documents); setReviewFingerprint(statusFingerprint(snapshot)); setReviewDiffBytes(bytes);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("ai.reviewFailed"));
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
        throw new Error(t("ai.stagedChanged"));
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
      setError(reason instanceof Error ? reason.message : t("ai.requestFailed"));
      setConfirmed(false);
    } finally { setBusy(false); }
  }

  const canUseSuggestion = Boolean(suggestion && suggestionText.trim() && !busy && !workspaceStale && !draftChanged && draftRef.current === requestDraft);

  return (
    <section className="commitAiAssistant" aria-labelledby="commit-ai-title">
      <div className="commitAiHeader"><h4 id="commit-ai-title">{t("ai.title")}</h4><button className="textButton" type="button" onClick={onClose}>{t("ai.close")}</button></div>
      <p className="settingsNotice">{t("ai.notice")}</p>
      <label className="commitAiOutputMode">{t("ai.output")}<select aria-label={t("ai.output")} value={outputMode} disabled={busy} onChange={(event) => { setOutputMode(event.target.value as typeof outputMode); setSuggestion(undefined); setSummaryResult(undefined); setSuggestionText(""); setConfirmed(false); setDraftChanged(false); }}><option value="commitMessage">{t("ai.modeCommit")}</option><option value="changeSummary">{t("ai.modeSummary")}</option></select></label>
      {busy && reviewed.length === 0 && <p role="status">{t("ai.loadingStaged")}</p>}
      {settings?.provider === "none" && <p className="settingsNotice">{t("ai.chooseProvider")}</p>}
      {settings?.provider === "openAiCompatible" && !settings.hasCloudCredential && <p className="settingsNotice">{t("ai.saveKey")}</p>}
      {reviewed.length > 0 && <>
        <div className="commitAiRequestDetails">
          <p><strong>{t("ai.endpoint")}</strong> {settings?.baseUrl || (settings?.provider === "ollama" ? t("ai.loopback") : t("ai.loadingProvider"))}</p>
          <p><strong>{t("ai.prompt")}</strong> {outputMode === "changeSummary" ? SUMMARY_PROMPT : PROMPT}</p>
          <p><strong>{t("ai.scope")}</strong> {t(reviewed.length === 1 ? "ai.scopeOne" : "ai.scopeMany", { count: reviewed.length, kib: (reviewDiffBytes / 1024).toFixed(1) })}</p>
        </div>
        {reviewed.map((file) => <details className="privacyDiffPreview" key={file.path} open>
          <summary>{file.path} · staged/index · {file.selections ? t(file.selections.length === 1 ? "ai.rangesOne" : "ai.rangesMany", { count: file.selections.length }) : t("ai.allStaged")}</summary>
          <pre>{diffText(file.document, file.selections) || t("ai.diffEmpty")}</pre>
        </details>)}
        {workspaceStale && <p role="alert" className="taskCenterError">{t("ai.stale")}</p>}
        {suggestion && workspaceStale && <p role="status">{t("ai.staleSuggestion")}</p>}
        {suggestion && draftChanged && <p role="status">{t("ai.draftChanged")}</p>}
        {!suggestion && !summaryResult && <label className="aiRequestConsent"><input type="checkbox" checked={confirmed} disabled={busy || workspaceStale} onChange={(event) => setConfirmed(event.target.checked)} />{t("ai.consent")}</label>}
        {suggestion && <>
          <label className="commitAiSuggestion">{t("ai.suggestionFrom", { provider: suggestion.provider, model: suggestion.model })}<textarea aria-label={t("ai.suggestionAria")} value={suggestionText} disabled={busy} onChange={(event) => setSuggestionText(event.target.value)} /></label>
          <div className="commitAiActions">
            <button type="button" className="secondaryButton" disabled={busy} onClick={() => void reviewCurrentChanges()}>{t("ai.reviewAgain")}</button>
            <button type="button" className="primaryButton" disabled={!canUseSuggestion} onClick={() => { if (canUseSuggestion) onUseSuggestion(suggestionText); }}>{t("ai.use")}</button>
          </div>
        </>}
        {summaryResult && <section className="commitAiSummary" aria-label={t("ai.summaryAria")}><h5>{t("ai.summaryHeading", { model: summaryResult.model })}</h5><pre>{summaryResult.response}</pre><button type="button" className="secondaryButton" disabled={busy} onClick={() => void reviewCurrentChanges()}>{t("ai.reviewAgain")}</button></section>}
        {!suggestion && !summaryResult && <button type="button" className="primaryButton" disabled={!confirmed || busy || settings?.provider === "none" || !settings || (settings.provider === "openAiCompatible" && !settings.hasCloudCredential)} onClick={() => void sendReviewed()}>{busy ? t("ai.waiting") : outputMode === "changeSummary" ? t("ai.summarize") : t("ai.send")}</button>}
      </>}
      {error && <div className="commitAiError" role="alert"><span>{error}</span><button type="button" className="secondaryButton" disabled={busy} onClick={() => void reviewCurrentChanges()}>{t("ai.reviewRetry")}</button></div>}
    </section>
  );
}
