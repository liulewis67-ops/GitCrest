import { useEffect, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type WorkflowPreflightResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import type { WorkflowAction } from "../model/workflow-action";

const labels: Record<WorkflowAction, string> = { merge: "Merge", cherryPick: "Cherry-pick", revert: "Revert" };

export function WorkflowDialog({ api, repoId, targetOid, action, targetLabel, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  targetOid: string;
  action: WorkflowAction;
  /** Human name of the target, such as a branch; shown instead of the generic "commit". */
  targetLabel?: string;
  onClose: () => void;
  onStarted: (task: Awaited<ReturnType<GitCrestApiClient["startRepositoryWorkflow"]>>) => void;
}) {
  const [state, setState] = useState<{ key: string; loading: boolean; snapshot?: WorkflowPreflightResponse; error?: string }>({ key: "", loading: false });
  const [busy, setBusy] = useState(false);
  const [noFastForward, setNoFastForward] = useState(false);
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const key = `${repoId}:${action}:${targetOid}`;

  useEffect(() => {
    const controller = new AbortController();
    setState({ key, loading: true });
    void api.withSignal(controller.signal).preflightRepositoryWorkflow(repoId, action, targetOid).then((snapshot) => {
      if (!controller.signal.aborted) setState({ key, loading: false, snapshot });
    }).catch((reason: unknown) => {
      const message = reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not inspect this Git operation.";
      if (!controller.signal.aborted) setState({ key, loading: false, error: message });
    });
    return () => controller.abort();
  }, [api, repoId, action, targetOid, key, refreshKey]);

  async function confirm() {
    const snapshot = state.key === key ? state.snapshot : undefined;
    if (!snapshot?.canStart || !snapshot.headOid || busy) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.startRepositoryWorkflow(repoId, { action, targetOid, expectedHeadOid: snapshot.headOid, ...(action === "merge" && noFastForward ? { noFastForward: true } : {}) }));
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not start this Git operation.");
    } finally {
      setBusy(false);
    }
  }

  const snapshot = state.key === key ? state.snapshot : undefined;
  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter workflowDialog" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader"><div><p className="sectionEyebrow">REVIEW GIT OPERATION</p><h2 id="workflow-dialog-title">{labels[action]} {targetLabel ?? "commit"}</h2></div><button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>Close</button></div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{targetLabel ? "TARGET BRANCH" : "TARGET COMMIT"}</span><strong className="monoText" title={targetOid}>{targetLabel ? `${targetLabel} · ${targetOid.slice(0, 12)}` : targetOid.slice(0, 12)}</strong></div>
        {state.key !== key || state.loading ? <p role="status">Checking repository state…</p> : state.error && <p className="taskCenterError" role="alert">{state.error}</p>}
        {snapshot && <>
          <div className="repositoryFact"><span>SUBJECT</span><strong>{snapshot.targetSubject || "(no subject)"}</strong></div>
          <div className="repositoryFact"><span>HEAD</span><strong className="monoText">{snapshot.headOid?.slice(0, 12) || "Unborn"}</strong></div>
          {snapshot.mergeKind === "upToDate" && <p className="cloneHelp" role="status">Already up to date: this commit is already part of the current branch, so there is nothing to merge.</p>}
          {snapshot.mergeKind === "fastForward" && <><p className="cloneHelp" role="status">{noFastForward ? `A merge commit will record this merge of ${snapshot.incomingCommitCount} commit(s), keeping the branch history visible.` : `Fast-forward: the current branch moves ahead by ${snapshot.incomingCommitCount} commit(s) and no merge commit is created.`}</p>
            <label className="rebaseConfirm"><input type="checkbox" checked={noFastForward} disabled={busy} onChange={(event) => setNoFastForward(event.target.checked)} />Always create a merge commit</label></>}
          {snapshot.mergeKind === "mergeCommit" && <p className="cloneHelp" role="status">A merge commit will combine {snapshot.incomingCommitCount} incoming commit(s) with the current branch. Conflicts, if any, open in the resolver.</p>}
          {snapshot.operationInProgress && <p className="taskCenterError" role="alert">A {snapshot.operationInProgress} operation is already in progress.</p>}
          {!snapshot.isClean && <p className="cloneHelp">Working tree has {snapshot.dirtyPaths.length + snapshot.omittedDirtyPathCount} change(s). Commit or shelve them before starting.</p>}
          {!snapshot.isClean && snapshot.dirtyPaths.length > 0 && <ul className="workflowPathList" aria-label="Uncommitted files">{snapshot.dirtyPaths.slice(0, 8).map((path) => <li key={path} title={path}>{path}</li>)}{snapshot.dirtyPaths.length > 8 && <li>…and {snapshot.dirtyPaths.length - 8 + snapshot.omittedDirtyPathCount} more</li>}</ul>}
          {snapshot.conflictedPaths.length > 0 && <ul className="workflowPathList">{snapshot.conflictedPaths.map((path) => <li key={path} title={path}>{path}</li>)}</ul>}
          {!snapshot.canStart && !snapshot.operationInProgress && snapshot.isClean && snapshot.mergeKind !== "upToDate" && <p className="cloneHelp">This operation is not available for the current repository state.</p>}
        </>}
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <div className="taskCenterActions"><button className="quietButton compact" type="button" disabled={busy || state.loading} onClick={() => { setError(""); setRefreshKey((current) => current + 1); }}>Refresh preview</button><button className="primaryButton" type="button" disabled={!snapshot?.canStart || !snapshot.headOid || busy} onClick={() => void confirm()}>{busy ? "Starting…" : `Start ${labels[action].toLowerCase()}`}</button></div>
      </div>
    </section>
  </div>;
}
