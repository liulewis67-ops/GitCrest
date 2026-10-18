import { useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";

/** Creates a branch that starts at a chosen commit, optionally switching to it. */
export function CreateBranchDialog({ api, repoId, startOid, disabled, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  startOid: string;
  disabled: boolean;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const [name, setName] = useState("");
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const ready = name.trim() !== "" && !disabled && !busy;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.createRepositoryBranch(repoId, name.trim(), { checkout, startPoint: startOid }));
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not create this branch.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter workflowDialog" role="dialog" aria-modal="true" aria-labelledby="create-branch-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">NEW BRANCH</p><h2 id="create-branch-title">Create branch here</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>Close</button>
      </div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>STARTS AT</span><strong className="monoText" title={startOid}>{startOid.slice(0, 12)}</strong></div>
        <label className="cloneField">Branch name<input autoFocus data-dialog-initial-focus value={name} spellCheck={false} placeholder="feature/my-change" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && ready) { event.preventDefault(); void submit(); } }} /></label>
        <label className="rebaseConfirm"><input type="checkbox" checked={checkout} onChange={(event) => setCheckout(event.target.checked)} />Switch to the new branch</label>
        {checkout && <p className="cloneHelp">Uncommitted changes that do not conflict with the new branch stay in your working tree.</p>}
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primaryButton" type="button" disabled={!ready} onClick={() => void submit()}>{busy ? "Creating…" : checkout ? "Create and switch" : "Create branch"}</button>
        </div>
      </div>
    </section>
  </div>;
}
