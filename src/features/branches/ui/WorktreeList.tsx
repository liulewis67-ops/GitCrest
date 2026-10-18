import { useEffect, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse, type WorktreeSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";

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
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<WorktreeSnapshotResponse>();
  const [confirming, setConfirming] = useState<string>();
  const [error, setError] = useState("");
  const [force, setForce] = useState(false);

  async function prune() {
    setError("");
    try {
      onRemoveStarted(await api.pruneRepositoryWorktrees(repoId));
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : t("wt.cleanupFailed"));
    }
  }

  async function remove(path: string, force: boolean) {
    setError("");
    try {
      onRemoveStarted(await api.removeRepositoryWorktree(repoId, path, force));
      setConfirming(undefined);
      setForce(false);
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : t("wt.removeFailed"));
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
      <div className="navGroupTitle"><span>{t("wt.title")}</span><span className="countBadge">{snapshot.worktrees.length}</span>{snapshot.worktrees.some((worktree) => worktree.prunable) && <button className="textButton" type="button" disabled={disabled} title={t("wt.forgetTitle")} onClick={() => void prune()}>{t("wt.cleanUp")}</button>}</div>
      {error && <p className="dialogError" role="alert">{error}</p>}
      <ul className="branchList" aria-label={t("wt.listAria")}>
        {snapshot.worktrees.map((worktree) => (
          <li className={`branchItem${worktree.isCurrent ? " current" : ""}`} key={worktree.path}>
            <span className="branchItemGlyph" aria-hidden="true">⧉</span>
            <span className="branchItemName" title={worktree.path}>{worktree.branch ?? (worktree.detached ? t("wt.detached", { oid: worktree.head?.slice(0, 7) ?? "" }) : leafName(worktree.path))}</span>
            {worktree.isDirty && !worktree.isCurrent && <span className="worktreeDirty" title={t("wt.dirtyTitle")} aria-label={t("wt.dirtyAria")}>●</span>}
            {worktree.isCurrent
              ? <span className="branchCurrentLabel">{t("wt.openLabel")}</span>
              : <button className="branchAction worktreeOpen" type="button" aria-label={t("wt.openAria", { name: leafName(worktree.path) })} title={worktree.path} disabled={disabled || worktree.prunable} onClick={() => onOpen(worktree.path)}>{worktree.prunable ? t("wt.missing") : t("wt.open")}</button>}
            {!worktree.isCurrent && !worktree.isMain && !worktree.prunable && (confirming === worktree.path
              ? <span className="worktreeConfirm">
                <label className="worktreeForce" title={t("wt.discardTitle")}><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />{t("wt.discard")}</label>
                <button className="branchAction" type="button" aria-label={t("wt.confirmAria", { name: leafName(worktree.path) })} disabled={disabled || (worktree.isDirty && !force)} title={worktree.isDirty && !force ? t("wt.tickDiscard") : undefined} onClick={() => void remove(worktree.path, force)}>{t("wt.confirm")}</button>
                <button className="branchAction" type="button" aria-label={t("wt.cancelAria")} onClick={() => setConfirming(undefined)}>{t("wt.cancel")}</button>
              </span>
              : <button className="branchAction worktreeRemove" type="button" aria-label={t("wt.removeAria", { name: leafName(worktree.path) })} title={t("wt.removeTitle", { path: worktree.path })} disabled={disabled || worktree.locked} onClick={() => { setForce(false); setConfirming(worktree.path); }}>{t("wt.remove")}</button>)}
          </li>
        ))}
      </ul>
    </div>
  </>;
}
