import { MetaList } from "../../../shared/ui/MetaList";
import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { type GitCrestApiClient, type WorkflowPreflightResponse } from "../../../api/client";
import type { WorkflowAction } from "../model/workflow-action";

export function WorkflowDialog({ api, repoId, targetOid, action, targetLabel, autoStart = false, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  targetOid: string;
  action: WorkflowAction;
  /** Human name of the target, such as a branch; shown instead of the generic "commit". */
  targetLabel?: string;
  /** Execute after a clean preflight; only show review for exceptions. */
  autoStart?: boolean;
  onClose: () => void;
  onStarted: (task: Awaited<ReturnType<GitCrestApiClient["startRepositoryWorkflow"]>>) => void;
}) {
  const { t } = useI18n();
  const labels: Record<WorkflowAction, string> = { merge: t("wf.merge"), cherryPick: t("wf.cherryPick"), revert: t("wf.revert") };
  const startLabels: Record<WorkflowAction, string> = { merge: t("wf.startMerge"), cherryPick: t("wf.startCherryPick"), revert: t("wf.startRevert") };
  const [state, setState] = useState<{ key: string; loading: boolean; snapshot?: WorkflowPreflightResponse; error?: DisplayError }>({ key: "", loading: false });
  const [busy, setBusy] = useState(false);
  const [noFastForward, setNoFastForward] = useState(false);

  const [error, setError] = useState<DisplayError>("");
  const [refreshKey, setRefreshKey] = useState(0);
  const key = `${repoId}:${action}:${targetOid}`;
  const [showReview, setShowReview] = useState(!autoStart);
  const autoAttempts = useRef(new Set<string>());
  const callbacks = useRef({ onClose, onStarted });
  callbacks.current = { onClose, onStarted };

  useEffect(() => {
    const controller = new AbortController();
    setState({ key, loading: true });
    setBusy(false);
    setError("");
    setShowReview(!autoStart || autoAttempts.current.has(key));
    void api.withSignal(controller.signal).preflightRepositoryWorkflow(repoId, action, targetOid).then(async (snapshot) => {
      if (controller.signal.aborted) return;
      setState({ key, loading: false, snapshot });
      if (!autoStart || autoAttempts.current.has(key)) return;
      autoAttempts.current.add(key);
      if (snapshot.mergeKind === "upToDate" && !snapshot.operationInProgress && snapshot.conflictedPaths.length === 0 && !snapshot.omittedConflictedPathCount) {
        callbacks.current.onClose();
        return;
      }
      if (!snapshot.canStart || !snapshot.headOid || !snapshot.isClean || snapshot.operationInProgress
        || snapshot.conflictedPaths.length > 0 || snapshot.omittedConflictedPathCount > 0) {
        setShowReview(true);
        return;
      }
      setBusy(true);
      try {
        const task = await api.startRepositoryWorkflow(repoId, { action, targetOid, expectedHeadOid: snapshot.headOid });
        if (!controller.signal.aborted) callbacks.current.onStarted(task);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(describeApiError(reason, t("wf.startFailed")));
          setShowReview(true);
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }).catch((reason: unknown) => {
      const message = describeApiError(reason, t("wf.inspectFailed"));
      if (!controller.signal.aborted) {
        autoAttempts.current.add(key);
        setState({ key, loading: false, error: message });
        setShowReview(true);
      }
    });
    return () => controller.abort();
  }, [api, repoId, action, targetOid, key, refreshKey, autoStart]);

  async function confirm() {
    const snapshot = state.key === key ? state.snapshot : undefined;
    if (!snapshot?.canStart || !snapshot.headOid || busy) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.startRepositoryWorkflow(repoId, { action, targetOid, expectedHeadOid: snapshot.headOid, ...(action === "merge" && noFastForward ? { noFastForward: true } : {}) }));
    } catch (reason) {
      setError(describeApiError(reason, t("wf.startFailed")));
    } finally {
      setBusy(false);
    }
  }

  const snapshot = state.key === key ? state.snapshot : undefined;
  if (autoStart && (!showReview || state.key !== key)) return null;
  return <Dialog className="taskCenter workflowDialog" role="dialog" aria-labelledby="workflow-dialog-title" onClose={onClose} busy={busy} closeLabel={t("wf.close")}>
      <DialogHeader className="taskCenterHeader"><div><h2 id="workflow-dialog-title">{t("wf.title", { action: labels[action], target: targetLabel ?? t("wf.commitWord") })}</h2></div></DialogHeader>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{targetLabel ? t("wf.targetBranch") : t("wf.targetCommit")}</span><strong className="monoText" title={targetOid}><MetaList items={[targetLabel, targetOid.slice(0, 12)]} /></strong></div>
        {state.key !== key || state.loading ? <p role="status">{t("wf.checking")}</p> : state.error && <p className="taskCenterError" role="alert"><ErrorMessage error={state.error} /></p>}
        {snapshot && <>
          <div className="repositoryFact"><span>{t("wf.subject")}</span><strong>{snapshot.targetSubject || t("push.noSubject")}</strong></div>
          <div className="repositoryFact"><span>{t("wf.head")}</span><strong className="monoText">{snapshot.headOid?.slice(0, 12) || t("wf.unborn")}</strong></div>
          {snapshot.mergeKind === "upToDate" && <p className="cloneHelp" role="status">{t("wf.upToDate")}</p>}
          {snapshot.mergeKind === "fastForward" && <><p className="cloneHelp" role="status">{noFastForward ? t("wf.mergeCommitWill", { count: snapshot.incomingCommitCount }) : t("wf.fastForward", { count: snapshot.incomingCommitCount })}</p>
            <label className="rebaseConfirm"><input type="checkbox" checked={noFastForward} disabled={busy} onChange={(event) => setNoFastForward(event.target.checked)} />{t("wf.alwaysMergeCommit")}</label></>}
          {snapshot.mergeKind === "mergeCommit" && <p className="cloneHelp" role="status">{t("wf.mergeCombine", { count: snapshot.incomingCommitCount })}</p>}
          {snapshot.operationInProgress && <p className="taskCenterError" role="alert">{t("wf.opInProgress", { op: snapshot.operationInProgress })}</p>}
          {action === "merge" && snapshot.canStart && <p className="cloneHelp">{t("wf.mergeKeepLocal")}</p>}
          {!snapshot.isClean && (action !== "merge" || snapshot.canStart) && <p className="cloneHelp">{t(action === "merge" ? "wf.mergeDirty" : "wf.dirty", { count: snapshot.dirtyPaths.length + snapshot.omittedDirtyPathCount })}</p>}
          {!snapshot.isClean && snapshot.dirtyPaths.length > 0 && <ul className="workflowPathList" aria-label={t("wf.uncommitted")}>{snapshot.dirtyPaths.slice(0, 8).map((path) => <li key={path} title={path}>{path}</li>)}{snapshot.dirtyPaths.length > 8 && <li>{t("wf.andMore", { count: snapshot.dirtyPaths.length - 8 + snapshot.omittedDirtyPathCount })}</li>}</ul>}
          {snapshot.conflictedPaths.length > 0 && <ul className="workflowPathList">{snapshot.conflictedPaths.map((path) => <li key={path} title={path}>{path}</li>)}</ul>}
          {!snapshot.canStart && !snapshot.operationInProgress && snapshot.isClean && snapshot.mergeKind !== "upToDate" && <p className="cloneHelp">{t("wf.notAvailable")}</p>}
        </>}
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}

      </div>
      <DialogFooter className="taskCenterActions"><Button variant="secondary" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button variant="quiet" size="compact" type="button" disabled={busy || state.loading} onClick={() => { setError(""); setRefreshKey((current) => current + 1); }}>{t("wf.refresh")}</Button><Button variant="primary" type="button" disabled={!snapshot?.canStart || !snapshot.headOid || busy} onClick={() => void confirm()}>{busy ? t("wf.starting") : startLabels[action]}</Button></DialogFooter>
    </Dialog>;
}
