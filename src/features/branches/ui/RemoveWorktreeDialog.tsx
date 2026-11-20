import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState } from "react";
import { type GitCrestApiClient, type TaskSnapshotResponse, type WorktreeSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";

type Worktree = WorktreeSnapshotResponse["worktrees"][number];

function messageOf(reason: unknown, fallback: string) {
  return describeApiError(reason, fallback);
}

function samePath(left: string, right: string) {
  const normal = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normal(left) === normal(right);
}

/**
 * Removes a linked worktree folder, after reading it again so uncommitted changes are never lost by surprise. The
 * branch it had checked out is kept unless the user asks for it to go too; an unmerged branch needs its own tick.
 */
export function RemoveWorktreeDialog({ api, repoId, path, disabled, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  path: string;
  disabled: boolean;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const [worktree, setWorktree] = useState<Worktree | null>();
  const [unmerged, setUnmerged] = useState<number>();
  const [discard, setDiscard] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [allowUnmerged, setAllowUnmerged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");

  useEffect(() => {
    const controller = new AbortController();
    const scoped = api.withSignal(controller.signal);
    void scoped.getRepositoryWorktrees(repoId).then(async (snapshot) => {
      if (controller.signal.aborted) return;
      const found = snapshot.worktrees.find((entry) => samePath(entry.path, path)) ?? null;
      setWorktree(found);
      if (!found?.branch) return;
      const preview = await scoped.previewRepositoryBranchDelete(repoId, found.branch);
      if (!controller.signal.aborted) setUnmerged(preview.unmergedCommitCount);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(messageOf(reason, t("rw.inspectFailed")));
    });
    return () => controller.abort();
  }, [api, repoId, path]);

  const blockedReason = !worktree ? undefined
    : worktree.isMain ? t("rw.isMain")
      : worktree.isCurrent ? t("rw.isCurrent")
        : worktree.locked ? t("rw.isLocked") : undefined;
  const branchUnmerged = deleteBranch && (unmerged ?? 0) > 0;
  const ready = Boolean(worktree) && !blockedReason && (!worktree?.isDirty || discard) && (!branchUnmerged || allowUnmerged)
    && (!deleteBranch || unmerged !== undefined) && !disabled && !busy;

  async function submit() {
    if (!ready || !worktree) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.removeRepositoryWorktree(repoId, worktree.path, discard, { deleteBranch, allowUnmerged: branchUnmerged }));
    } catch (reason) {
      setError(messageOf(reason, t("wt.removeFailed")));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog className="taskCenter workflowDialog" role="dialog" aria-labelledby="remove-worktree-title" onClose={onClose} busy={busy} closeLabel={t("rw.close")}>
      <DialogHeader className="taskCenterHeader">
        <div><h2 id="remove-worktree-title">{t("rw.title")}</h2></div>

      </DialogHeader>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{t("rw.folder")}</span><strong className="monoText" title={path}>{path}</strong></div>
        {worktree?.branch && <div className="repositoryFact"><span>{t("rw.branch")}</span><strong>{worktree.branch}</strong></div>}
        {worktree === undefined && !error && <p role="status">{t("rw.checking")}</p>}
        {worktree === null && <p className="taskCenterError" role="alert">{t("rw.notFound")}</p>}
        {blockedReason && <p className="taskCenterError" role="alert">{blockedReason}</p>}
        {worktree && !blockedReason && <>
          {worktree.isDirty
            ? <label className="rebaseConfirm"><input type="checkbox" checked={discard} onChange={(event) => setDiscard(event.target.checked)} />{t("rw.discard")}</label>
            : <>
              <p className="cloneHelp">{t("rw.clean")}</p>
              <label className="rebaseConfirm"><input type="checkbox" checked={discard} onChange={(event) => setDiscard(event.target.checked)} />{t("rw.force")}</label>
            </>}
          {worktree.branch && <label className="rebaseConfirm"><input type="checkbox" checked={deleteBranch} onChange={(event) => { setDeleteBranch(event.target.checked); setAllowUnmerged(false); }} />{t("rw.deleteBranch", { name: worktree.branch })}</label>}
          {branchUnmerged && <label className="rebaseConfirm"><input type="checkbox" checked={allowUnmerged} onChange={(event) => setAllowUnmerged(event.target.checked)} />{t("lb.unmerged", { name: worktree.branch ?? "", count: unmerged ?? 0 })}</label>}
          {!deleteBranch && worktree.branch && <p className="cloneHelp">{t("rw.branchKept", { name: worktree.branch })}</p>}
        </>}
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
        <DialogFooter className="taskCenterActions">
          <Button variant="secondary" type="button" disabled={busy} onClick={onClose}>{t("rw.cancel")}</Button>
          <Button variant="danger" type="button" disabled={!ready} onClick={() => void submit()}>{busy ? t("rw.removing") : deleteBranch ? t("rw.removeBoth") : t("rw.remove")}</Button>
        </DialogFooter>
      </div>
    </Dialog>;
}
