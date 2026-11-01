import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState } from "react";
import {
  type GitCrestApiClient,
  type RemoteTagPreviewResponse,
  type TagEntryResponse,
  type TaskSnapshotResponse,
} from "../../../api/client";
import { useI18n } from "../../../shared/i18n";

export type TagAction = "push" | "delete" | "remoteDelete";

function errorMessage(error: unknown, fallback: string) {
  return describeApiError(error, fallback);
}

/**
 * Reviews one tag change before it runs: a local delete names the commit it removes the tag from,
 * a push shows what the remote has, and a remote delete names the remote and the object it leases.
 */
export function TagActionsDialog({ api, repoId, action, tag, remoteNames, onClose, onDeleted, onTaskStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  action: TagAction;
  tag: TagEntryResponse;
  remoteNames: readonly string[];
  onClose: () => void;
  onDeleted: () => void;
  onTaskStarted: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const [remote, setRemote] = useState(remoteNames[0] ?? "");
  const [preview, setPreview] = useState<RemoteTagPreviewResponse>();
  const [checking, setChecking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const needsRemote = action !== "delete";

  useEffect(() => {
    if (!needsRemote || !remote) return;
    const controller = new AbortController();
    setChecking(true);
    setPreview(undefined);
    setError("");
    setConfirmed(false);
    api.withSignal(controller.signal).previewRemoteTag(repoId, remote, tag.name)
      .then((value) => { if (!controller.signal.aborted) setPreview(value); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, t("tags.checkFailed"))); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [api, repoId, remote, tag.name, needsRemote]);

  const short = (oid: string | null | undefined) => (oid ? oid.slice(0, 12) : "");
  const remoteDiffers = Boolean(preview?.remoteOid && !preview.sameAsLocal);
  const canRun = action === "delete"
    ? confirmed
    : action === "push"
      ? Boolean(preview) && !remoteDiffers && !preview?.sameAsLocal
      : Boolean(preview?.remoteOid) && confirmed;

  async function run() {
    setBusy(true);
    setError("");
    try {
      if (action === "delete") {
        await api.deleteRepositoryTag(repoId, tag.name, tag.targetOid);
        onDeleted();
      } else if (action === "push") {
        onTaskStarted(await api.pushRepositoryTag(repoId, remote, tag.name));
      } else if (preview?.remoteOid) {
        onTaskStarted(await api.deleteRemoteTag(repoId, remote, tag.name, preview.remoteOid));
      }
    } catch (reason) {
      setError(errorMessage(reason, t("tags.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  const title = action === "push" ? "tags.dialogPush" : action === "delete" ? "tags.dialogDelete" : "tags.dialogRemoteDelete";
  const danger = action !== "push";
  return <Dialog className="cloneDialog tagActionsDialog" role="dialog" aria-labelledby="tag-actions-title" onClose={onClose} busy={busy} closeLabel={t("tags.close")}>
      <DialogHeader className="taskCenterHeader">
        <div><h2 id="tag-actions-title">{t(title, { name: tag.name })}</h2></div>

      </DialogHeader>
      <div className="cloneFormBody">
        <p className="cloneHelp">{t("tags.localPoints", { oid: short(tag.targetOid) })}</p>
        {needsRemote && <label className="rebaseTargetField">{t("tags.remote")}
          <select value={remote} disabled={busy} onChange={(event) => setRemote(event.target.value)}>
            {remoteNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        {checking && <p role="status" className="cloneHelp">{t("tags.checking")}</p>}
        {preview && action === "push" && <p className={remoteDiffers ? "taskCenterError" : "cloneHelp"} role={remoteDiffers ? "alert" : "status"}>
          {remoteDiffers ? t("tags.remoteDiffers", { oid: short(preview.remoteOid) }) : preview.sameAsLocal ? t("tags.remoteSame") : t("tags.remoteMissing")}
        </p>}
        {preview && action === "remoteDelete" && (preview.remoteOid
          ? <p className="cloneHelp" role="status">{t("tags.remoteHas", { remote, oid: short(preview.remoteOid) })}</p>
          : <p className="cloneHelp" role="status">{t("tags.remoteMissing")}</p>)}
        {action === "delete" && <p className="pushWarning">{t("tags.deleteLocalWarning")}</p>}
        {action === "remoteDelete" && preview?.remoteOid && <p className="pushWarning">{t("tags.deleteRemoteWarning", { remote })}</p>}
        {danger && <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} disabled={busy || (action === "remoteDelete" && !preview?.remoteOid)} onChange={(event) => setConfirmed(event.target.checked)} />{t("tags.confirmDelete")}</label>}
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
      </div>
      <DialogFooter className="cloneDialogActions">
        <Button variant="quiet" type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant={danger ? "danger" : "primary"} type="button" disabled={busy || checking || !canRun} onClick={() => void run()}>
          {busy ? t("tags.working") : action === "push" ? t("tags.doPush") : action === "delete" ? t("tags.doDelete") : t("tags.doDeleteRemote")}
        </Button>
      </DialogFooter>
    </Dialog>;
}
