import { useEffect, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";

export type LocalBranchAction = { name: string; mode: "rename" | "delete" };

function messageOf(reason: unknown, fallback: string) {
  return reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : fallback;
}

export function LocalBranchDialog({ api, repoId, action, disabled, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  action: LocalBranchAction;
  disabled: boolean;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const [newName, setNewName] = useState(action.name);
  const [preview, setPreview] = useState<{ isCurrent: boolean; unmergedCommitCount: number; requiresConfirmation: boolean }>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);

  useEffect(() => {
    if (action.mode !== "delete") return;
    const controller = new AbortController();
    setPreview(undefined);
    setConfirmed(false);
    setError("");
    void api.withSignal(controller.signal).previewRepositoryBranchDelete(repoId, action.name).then((result) => {
      if (!controller.signal.aborted) setPreview(result);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(messageOf(reason, "Could not inspect this branch."));
    });
    return () => controller.abort();
  }, [api, repoId, action.mode, action.name]);

  async function submit() {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      if (action.mode === "rename") onStarted(await api.renameRepositoryBranch(repoId, action.name, newName.trim()));
      else onStarted(await api.deleteRepositoryBranch(repoId, action.name, Boolean(preview?.requiresConfirmation)));
    } catch (reason) {
      setError(messageOf(reason, action.mode === "rename" ? "Could not rename this branch." : "Could not delete this branch."));
    } finally {
      setBusy(false);
    }
  }

  const renameReady = action.mode === "rename" && newName.trim() !== "" && newName.trim() !== action.name;
  const deleteReady = action.mode === "delete" && Boolean(preview) && !preview?.isCurrent && (!preview?.requiresConfirmation || confirmed);
  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter workflowDialog" role="dialog" aria-modal="true" aria-labelledby="local-branch-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">LOCAL BRANCH</p><h2 id="local-branch-title">{action.mode === "rename" ? "Rename branch" : "Delete branch"}</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>Close</button>
      </div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>BRANCH</span><strong>{action.name}</strong></div>
        {action.mode === "rename" && <label className="cloneField">New name<input autoFocus data-dialog-initial-focus value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && renameReady) { event.preventDefault(); void submit(); } }} spellCheck={false} /></label>}
        {action.mode === "delete" && !preview && !error && <p role="status">Checking for unmerged commits…</p>}
        {action.mode === "delete" && preview?.isCurrent && <p className="taskCenterError" role="alert">The current branch cannot be deleted. Switch to another branch first.</p>}
        {action.mode === "delete" && preview && !preview.isCurrent && (preview.requiresConfirmation
          ? <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{action.name} has {preview.unmergedCommitCount} commit(s) that are not reachable from the current branch. Delete it anyway.</label>
          : <p className="cloneHelp">All commits on this branch are reachable from the current branch, so nothing is lost.</p>)}
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          {action.mode === "rename"
            ? <button className="primaryButton" type="button" disabled={!renameReady || disabled || busy} onClick={() => void submit()}>{busy ? "Renaming…" : "Rename branch"}</button>
            : <button className="dangerTextButton" type="button" disabled={!deleteReady || disabled || busy} onClick={() => void submit()}>{busy ? "Deleting…" : "Delete branch"}</button>}
        </div>
      </div>
    </section>
  </div>;
}
