import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AiReplyResponse, AiSettingsResponse, DiffDocumentResponse, GitCrestApiClient, StatusSnapshotResponse } from "../../../api/client";
import { activeProvider } from "../model/ai-providers";

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
  const { t } = useI18n();
  const provider = activeProvider(settings);
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
  const [error, setError] = useState<DisplayError>("");
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
      if (!controller.signal.aborted) setError(describeApiError(reason, t("pv.loadFailed")));
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
  }, [provider?.id, provider?.apiFormat, provider?.baseUrl, provider?.model]);

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
      if (!controller.signal.aborted && diffRequest.current === requestId) setError(describeApiError(reason, t("pv.previewFailed")));
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
        if (document.status !== "text") throw new Error(t("pv.cannotSend", { path: candidate.path, status: document.status }));
        byteCount += new TextEncoder().encode(diffText(document)).length;
        if (byteCount > 1024 * 1024) throw new Error(t("pv.tooBig"));
        documents.push({ candidate, document });
      }
      if (!controller.signal.aborted && reviewAttempt.current === attempt) {
        setReviewed(documents);
        setConfirmSend(true);
      }
    } catch (reason) {
      if (!controller.signal.aborted && reviewAttempt.current === attempt) setError(describeApiError(reason, t("pv.prepFailed")));
    } finally {
      if (reviewController.current === controller) reviewController.current = undefined;
      if (!controller.signal.aborted && reviewAttempt.current === attempt) setReviewBusy(false);
    }
  }

  async function sendReviewedDiffs() {
    if (!repoId || !provider || !confirmed || reviewed.length !== selected.length) return;
    setRequestBusy(true); setError(""); setReply(undefined);
    try {
      const result = await api.requestAiReview(repoId, prompt, reviewed.map(({ candidate, document }) => ({
        path: candidate.path,
        scope: candidate.scope,
        revision: document.revision,
      })));
      setReply(result); setConfirmSend(false); setConfirmed(false);
    } catch (reason) {
      setError(describeApiError(reason, t("pv.requestFailed")));
      setReviewed([]); setConfirmSend(false); setConfirmed(false);
    } finally { setRequestBusy(false); }
  }

  return (
    <section className="privacyScope" aria-labelledby="privacy-scope-title">
      <div className="privacyScopeHeader"><div><h3 id="privacy-scope-title">{t("pv.heading")}</h3><p>{t("pv.intro")}</p></div><span className="privacyScopeCount" aria-live="polite">{t("pv.selected", { count: selected.length })}</span></div>
      {!repoId ? <p className="settingsNotice">{t("pv.openRepo")}</p> : !status && !error ? <p className="settingsNotice" role="status">{t("pv.loading")}</p> : null}
      {status && candidates.length === 0 && <p className="settingsNotice">{t("pv.noChanges")}</p>}
      {status && candidates.length > 0 && <ul className="privacyScopeList">
        {visibleCandidates.map((candidate) => {
          const included = selectedIds.includes(candidate.id);
          return <li key={candidate.id}>
            <label><input type="checkbox" checked={included} disabled={requestBusy || reviewBusy} onChange={() => toggle(candidate)} /><span className="privacyScopePath">{candidate.path}</span><span className="privacyScopeScope">{candidate.scope === "index" ? t("pv.staged") : t("pv.unstaged")}</span></label>
            {included && <button type="button" className="textButton" disabled={requestBusy || reviewBusy} onClick={() => void showDiff(candidate)}>{t("pv.previewDiff")}</button>}
          </li>;
        })}
      </ul>}
      {omittedCandidateCount > 0 && <p className="settingsNotice">{t("pv.omitted", { count: omittedCandidateCount })}</p>}
      {selected.length > 0 && <p className="privacyScopeSummary">{t(selected.length === 1 ? "pv.limitedOne" : "pv.limitedMany", { count: selected.length })}</p>}
      {selected.length > 0 && settings && !provider && <p className="settingsNotice">{t("pv.chooseProvider")}</p>}
      {selected.length > 0 && <button type="button" className="secondaryButton" disabled={reviewBusy || selected.length > 20 || !provider} onClick={() => void reviewSelected()}>{reviewBusy ? t("pv.loadingDiffs") : t("pv.reviewAll")}</button>}
      {selected.length > 20 && <p className="taskCenterError" role="alert">{t("pv.atMost20")}</p>}
      {selectedDiff && <section className="privacyDiffPreview" aria-label={t("pv.diffPreviewAria", { path: selectedDiff.path })}>
        <header><strong>{selectedDiff.path}</strong><span>{selectedDiff.scope === "index" ? t("pv.scopeIndex") : t("pv.scopeWorking")}</span></header>
        {loading ? <p role="status">{t("pv.loadingDiff")}</p> : document?.status === "binary" ? <p>{t("pv.binary")}</p> : document?.status !== "text" ? <p>{document ? t("pv.notAvailable", { status: document.status }) : ""}</p> : <pre>{diffText(document) || t("pv.empty")}</pre>}
      </section>}
      {confirmSend && reviewed.length > 0 && <section className="aiRequestReview" aria-labelledby="ai-request-review-title">
        <h4 id="ai-request-review-title">{t("pv.confirmHeading")}</h4>
        {provider && <p>{t(provider.isLocal ? "pv.sentLocal" : "pv.sentCloud", { name: provider.name, url: provider.baseUrl })}</p>}
        <label>{t("pv.prompt")}<textarea aria-label={t("pv.promptAria")} disabled={requestBusy} maxLength={2048} value={prompt} onChange={(event) => { setPrompt(event.target.value); setConfirmed(false); }} /></label>
        {reviewed.map(({ candidate, document }) => <details className="privacyDiffPreview" key={candidate.id} open>
          <summary>{t("pv.rows", { path: candidate.path, scope: candidate.scope === "index" ? t("pv.scopeIndex") : t("pv.scopeWorking"), count: document.hunks.reduce((count, hunk) => count + hunk.rows.length, 0) })}</summary>
          <pre>{diffText(document)}</pre>
        </details>)}
        <label className="aiRequestConsent"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t("pv.consent")}</label>
        <button type="button" className="primaryButton" disabled={!confirmed || !prompt.trim() || requestBusy || !provider} onClick={() => void sendReviewedDiffs()}>{requestBusy ? t("pv.waiting") : t("pv.send")}</button>
      </section>}
      {reply && <section className="aiReply" aria-labelledby="ai-reply-title"><h4 id="ai-reply-title">{t("pv.response", { model: reply.model })}</h4><p>{t("pv.sentScopes", { files: reply.files.join(", ") })}</p><pre>{reply.response}</pre></section>}
      {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
    </section>
  );
}
