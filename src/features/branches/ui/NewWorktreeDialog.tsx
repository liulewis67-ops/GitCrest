import { useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { rememberWorktreeParent, suggestWorktreePath, worktreePathInParent } from "../model/worktree-path";

/** Checks an existing local branch out into a new worktree folder. */
export function NewWorktreeDialog({ api, repoId, repositoryPath, branch, fromRemote = false, disabled, onChooseFolder, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  repositoryPath?: string;
  branch: string;
  /** `branch` is a remote-tracking branch such as origin/feature; a local tracking branch is created. */
  fromRemote?: boolean;
  disabled: boolean;
  onChooseFolder?: () => Promise<string | undefined>;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const localName = fromRemote ? branch.slice(branch.indexOf("/") + 1) : branch;
  const suggested = suggestWorktreePath(repositoryPath, localName);
  const [folder, setFolder] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const ready = folder.trim() !== "" && !disabled && !busy;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const task = await api.addRepositoryWorktree(repoId, branch, folder.trim(), fromRemote);
      rememberWorktreeParent(folder);
      onStarted(task);
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not create this worktree.");
    } finally {
      setBusy(false);
    }
  }

  const browse = async () => {
    try {
      const parent = await onChooseFolder?.();
      if (parent) setFolder(worktreePathInParent(parent, suggested || branch));
    } catch {
      /* the picker was dismissed or unavailable; keep the current folder */
    }
  };

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter workflowDialog" role="dialog" aria-modal="true" aria-labelledby="new-worktree-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">NEW WORKTREE</p><h2 id="new-worktree-title">Open branch in a new worktree</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>Close</button>
      </div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{fromRemote ? "REMOTE BRANCH" : "BRANCH"}</span><strong>{branch}</strong></div>
        {fromRemote && <p className="cloneHelp">A local branch named <strong>{localName}</strong> will be created in the worktree and set to track {branch}.</p>}
        <label className="branchWorktreeField">Worktree folder
          <span className="branchWorktreeInput">
            <input autoFocus data-dialog-initial-focus value={folder} aria-label="Worktree folder" spellCheck={false} onChange={(event) => setFolder(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && ready) { event.preventDefault(); void submit(); } }} />
            {onChooseFolder && <button className="secondaryButton" type="button" onClick={() => void browse()}>Browse…</button>}
          </span>
        </label>
        <p className="cloneHelp">The folder must be new or empty. Your current working tree is not touched. Open the new worktree afterwards from the Worktrees list.</p>
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primaryButton" type="button" disabled={!ready} onClick={() => void submit()}>{busy ? "Creating…" : "Create worktree"}</button>
        </div>
      </div>
    </section>
  </div>;
}
