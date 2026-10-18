import { useEffect, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse, type WorktreeSnapshotResponse } from "../../../api/client";

function leafName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Lists the other working trees of the repository and opens one as its own repository tab. */
export function WorktreeList({ api, repoId, refreshKey, disabled, onOpen, onRemoveStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  refreshKey: number;
  disabled: boolean;
  onOpen: (path: string) => void;
  onRemoveStarted: (task: TaskSnapshotResponse) => void;
}) {
  const [snapshot, setSnapshot] = useState<WorktreeSnapshotResponse>();
  const [confirming, setConfirming] = useState<string>();
  const [error, setError] = useState("");
  const [force, setForce] = useState(false);

  async function prune() {
    setError("");
    try {
      onRemoveStarted(await api.pruneRepositoryWorktrees(repoId));
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not clean up the worktree list.");
    }
  }

  async function remove(path: string, force: boolean) {
    setError("");
    try {
      onRemoveStarted(await api.removeRepositoryWorktree(repoId, path, force));
      setConfirming(undefined);
      setForce(false);
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not remove this worktree.");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void api.withSignal(controller.signal).getRepositoryWorktrees(repoId).then((result) => {
      if (!controller.signal.aborted) setSnapshot(result);
    }).catch(() => {
      if (!controller.signal.aborted) setSnapshot(undefined);
    });
    return () => controller.abort();
  }, [api, repoId, refreshKey]);

  if (!snapshot?.worktrees || snapshot.worktrees.length < 2) return null;
  return <>
    <div className="navDivider" />
    <div className="navGroup worktreesNavigation">
      <div className="navGroupTitle"><span>Worktrees</span><span className="countBadge">{snapshot.worktrees.length}</span>{snapshot.worktrees.some((worktree) => worktree.prunable) && <button className="textButton" type="button" disabled={disabled} title="Forget worktrees whose folders were deleted outside GitCrest" onClick={() => void prune()}>Clean up missing</button>}</div>
      {error && <p className="dialogError" role="alert">{error}</p>}
      <ul className="branchList" aria-label="Repository worktrees">
        {snapshot.worktrees.map((worktree) => (
          <li className={`branchItem${worktree.isCurrent ? " current" : ""}`} key={worktree.path}>
            <span className="branchItemGlyph" aria-hidden="true">⧉</span>
            <span className="branchItemName" title={worktree.path}>{worktree.branch ?? (worktree.detached ? `Detached ${worktree.head?.slice(0, 7) ?? ""}` : leafName(worktree.path))}</span>
            {worktree.isDirty && !worktree.isCurrent && <span className="worktreeDirty" title="This worktree has uncommitted changes" aria-label="Has uncommitted changes">●</span>}
            {worktree.isCurrent
              ? <span className="branchCurrentLabel">OPEN</span>
              : <button className="branchAction worktreeOpen" type="button" aria-label={`Open worktree ${leafName(worktree.path)}`} title={worktree.path} disabled={disabled || worktree.prunable} onClick={() => onOpen(worktree.path)}>{worktree.prunable ? "Missing" : "Open"}</button>}
            {!worktree.isCurrent && !worktree.isMain && !worktree.prunable && (confirming === worktree.path
              ? <span className="worktreeConfirm">
                <label className="worktreeForce" title="Also discard uncommitted changes in that folder"><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />Discard changes</label>
                <button className="branchAction" type="button" aria-label={`Confirm remove worktree ${leafName(worktree.path)}`} disabled={disabled || (worktree.isDirty && !force)} title={worktree.isDirty && !force ? "This worktree has uncommitted changes. Tick Discard changes to remove it." : undefined} onClick={() => void remove(worktree.path, force)}>Confirm</button>
                <button className="branchAction" type="button" aria-label="Cancel remove" onClick={() => setConfirming(undefined)}>Cancel</button>
              </span>
              : <button className="branchAction worktreeRemove" type="button" aria-label={`Remove worktree ${leafName(worktree.path)}`} title={`Remove ${worktree.path} (the branch is kept)`} disabled={disabled || worktree.locked} onClick={() => { setForce(false); setConfirming(worktree.path); }}>Remove</button>)}
          </li>
        ))}
      </ul>
    </div>
  </>;
}
