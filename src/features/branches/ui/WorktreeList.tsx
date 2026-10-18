import { useEffect, useState } from "react";
import type { GitCrestApiClient, WorktreeSnapshotResponse } from "../../../api/client";

function leafName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Lists the other working trees of the repository and opens one as its own repository tab. */
export function WorktreeList({ api, repoId, refreshKey, disabled, onOpen }: {
  api: GitCrestApiClient;
  repoId: string;
  refreshKey: number;
  disabled: boolean;
  onOpen: (path: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<WorktreeSnapshotResponse>();

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
      <div className="navGroupTitle"><span>Worktrees</span><span className="countBadge">{snapshot.worktrees.length}</span></div>
      <ul className="branchList" aria-label="Repository worktrees">
        {snapshot.worktrees.map((worktree) => (
          <li className={`branchItem${worktree.isCurrent ? " current" : ""}`} key={worktree.path}>
            <span className="branchItemGlyph" aria-hidden="true">⧉</span>
            <span className="branchItemName" title={worktree.path}>{worktree.branch ?? (worktree.detached ? `Detached ${worktree.head?.slice(0, 7) ?? ""}` : leafName(worktree.path))}</span>
            {worktree.isCurrent
              ? <span className="branchCurrentLabel">OPEN</span>
              : <button className="branchAction worktreeOpen" type="button" aria-label={`Open worktree ${leafName(worktree.path)}`} title={worktree.path} disabled={disabled || worktree.prunable} onClick={() => onOpen(worktree.path)}>{worktree.prunable ? "Missing" : "Open"}</button>}
          </li>
        ))}
      </ul>
    </div>
  </>;
}
