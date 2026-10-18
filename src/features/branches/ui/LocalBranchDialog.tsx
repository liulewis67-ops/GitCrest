import { useEffect, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";

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
  const { t } = useI18n();
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
      if (!controller.signal.aborted) setError(messageOf(reason, t("lb.inspectFailed")));
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
      setError(messageOf(reason, action.mode === "rename" ? t("lb.renameFailed") : t("lb.deleteFailed")));
    } finally {
      setBusy(false);
    }
  }

  const renameReady = action.mode === "rename" && newName.trim() !== "" && newName.trim() !== action.name;
  const deleteReady = action.mode === "delete" && Boolean(preview) && !preview?.isCurrent && (!preview?.requiresConfirmation || confirmed);
  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter workflowDialog" role="dialog" aria-modal="true" aria-labelledby="local-branch-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">{t("lb.eyebrow")}</p><h2 id="local-branch-title">{action.mode === "rename" ? t("lb.renameTitle") : t("lb.deleteTitle")}</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>{t("lb.close")}</button>
      </div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{t("lb.branch")}</span><strong>{action.name}</strong></div>
        {action.mode === "rename" && <label className="cloneField">{t("lb.newName")}<input autoFocus data-dialog-initial-focus value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && renameReady) { event.preventDefault(); void submit(); } }} spellCheck={false} /></label>}
        {action.mode === "delete" && !preview && !error && <p role="status">{t("lb.checking")}</p>}
        {action.mode === "delete" && preview?.isCurrent && <p className="taskCenterError" role="alert">{t("lb.cannotDeleteCurrent")}</p>}
        {action.mode === "delete" && preview && !preview.isCurrent && (preview.requiresConfirmation
          ? <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t("lb.unmerged", { name: action.name, count: preview.unmergedCommitCount })}</label>
          : <p className="cloneHelp">{t("lb.allReachable")}</p>)}
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>{t("lb.cancel")}</button>
          {action.mode === "rename"
            ? <button className="primaryButton" type="button" disabled={!renameReady || disabled || busy} onClick={() => void submit()}>{busy ? t("lb.renaming") : t("lb.renameBtn")}</button>
            : <button className="dangerTextButton" type="button" disabled={!deleteReady || disabled || busy} onClick={() => void submit()}>{busy ? t("lb.deleting") : t("lb.deleteBtn")}</button>}
        </div>
      </div>
    </section>
  </div>;
}
