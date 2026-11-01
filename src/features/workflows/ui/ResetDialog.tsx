import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useState } from "react";
import { GitCrestApiError, type BranchSnapshotResponse, type GitCrestApiClient, type ResetBackupSnapshotResponse, type ResetPreviewResponse, type TaskSnapshotResponse } from "../../../api/client";
import type { components } from "../../../api/schema";

type ResetMode = components["schemas"]["ResetMode"];
const MODES: ResetMode[] = ["soft", "mixed", "hard"];

export function ResetDialog({ api, repoId, branches, initialTargetOid, disabled, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  branches?: BranchSnapshotResponse;
  /** A commit chosen in History: selected as the target and listed even when no branch points at it. */
  initialTargetOid?: string;
  disabled: boolean;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const current = branches?.branches.find((branch) => branch.isCurrent);
  const targets = (branches?.branches || []).filter((branch) => !branch.isCurrent && branch.oid !== current?.oid);
  const [targetOid, setTargetOid] = useState(initialTargetOid || "");
  const [mode, setMode] = useState<ResetMode>("mixed");
  const [preview, setPreview] = useState<ResetPreviewResponse>();
  const [backupSnapshot, setBackupSnapshot] = useState<ResetBackupSnapshotResponse>();
  const [selectedBackup, setSelectedBackup] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");

  useEffect(() => {
    const controller = new AbortController();
    void api.withSignal(controller.signal).getRepositoryResetBackups(repoId).then((snapshot) => {
      if (controller.signal.aborted) return;
      setBackupSnapshot(snapshot);
      setSelectedBackup(snapshot.backups[0]?.reference || "");
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof GitCrestApiError ? describeApiError(reason) : t("rs.loadBackups"));
    });
    return () => controller.abort();
  }, [api, repoId]);

  async function inspect() {
    if (!targetOid || disabled || loading || busy) return;
    setLoading(true);
    setError("");
    setPreview(undefined);
    setConfirmed(false);
    try {
      setPreview(await api.preflightRepositoryReset(repoId, targetOid, mode));
    } catch (reason) {
      setError(describeApiError(reason, t("rs.inspectFailed")));
    } finally {
      setLoading(false);
    }
  }

  async function start() {
    if (!preview?.canStart || !confirmed || disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.startRepositoryReset(repoId, {
        expectedHeadOid: preview.expectedHeadOid,
        targetOid: preview.targetOid,
        mode: preview.mode,
        previewRevision: preview.previewRevision,
        confirmReset: true,
      }));
    } catch (reason) {
      setError(describeApiError(reason, t("rs.startFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    const backup = backupSnapshot?.backups.find((item) => item.reference === selectedBackup);
    if (!backupSnapshot?.canRestore || !backupSnapshot.headOid || !backup || !confirmRestore || disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.restoreRepositoryReset(repoId, {
        expectedHeadOid: backupSnapshot.headOid,
        backupReference: backup.reference,
        backupOid: backup.oid,
        confirmRestore: true,
      }));
    } catch (reason) {
      setError(describeApiError(reason, t("rs.restoreFailed")));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog className="taskCenter resetDialog" role="dialog" aria-labelledby="reset-dialog-title" onClose={onClose} busy={busy} closeLabel={t("rs.close")}>
      <DialogHeader className="taskCenterHeader">
        <div><h2 id="reset-dialog-title">{t("rs.title")}</h2></div>

      </DialogHeader>
      <div className="workflowDialogBody">
        <label className="rebaseTargetField" htmlFor="reset-target">{t("rs.moveTo", { name: current?.fullName || t("rs.currentBranch") })}
          <select data-dialog-initial-focus id="reset-target" value={targetOid} disabled={disabled || loading || busy} onChange={(event) => { setTargetOid(event.target.value); setPreview(undefined); setConfirmed(false); }}>
            <option value="">{t("rs.chooseCommit")}</option>
            {initialTargetOid && !targets.some((branch) => branch.oid === initialTargetOid) && <option value={initialTargetOid}>{t("rs.commitOption", { oid: initialTargetOid.slice(0, 9) })}</option>}
            {targets.map((branch) => <option key={`${branch.fullName}:${branch.oid}`} value={branch.oid}>{branch.fullName} · {branch.oid.slice(0, 9)}</option>)}
          </select>
        </label>
        <label className="rebaseTargetField" htmlFor="reset-mode">{t("rs.mode")}
          <select id="reset-mode" value={mode} disabled={disabled || loading || busy} onChange={(event) => { setMode(event.target.value as ResetMode); setPreview(undefined); setConfirmed(false); }}>
            {MODES.map((option) => <option key={option} value={option}>{t(`rs.mode.${option}`)}</option>)}
          </select>
        </label>
        <p className="cloneHelp" role="note">{t(`rs.consequence.${mode}`)}</p>
        <details className="resetModeHelp"><summary>{t("rs.compareModes")}</summary><p className="cloneHelp">{t("rs.modeHelp")}</p></details>
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}

        {loading && <p role="status">{t("rs.reviewing")}</p>}
        {preview && <>
          <div className="rebasePreviewFacts">
            <div className="repositoryFact"><span>{t("rs.branch")}</span><strong>{preview.currentBranch}</strong></div>
            <div className="repositoryFact"><span>{t("rs.modeLabel")}</span><strong>{preview.mode}</strong></div>
            <div className="repositoryFact"><span>{t("rs.commits")}</span><strong>{t("rs.removedAdded", { removed: preview.commitsRemoved, added: preview.commitsAdded })}</strong></div>
            <div className="repositoryFact"><span>{t("rs.target")}</span><strong className="monoText">{preview.targetOid.slice(0, 12)}</strong></div>
          </div>
          <section className="operationImpactNotice" aria-label={t("rs.impactAria")}>
            <h3>{t("rs.impactHeading")}</h3>
            <p>{t("rs.impactMove", { branch: preview.currentBranch, from: preview.expectedHeadOid.slice(0, 12), to: preview.targetOid.slice(0, 12), removed: preview.commitsRemoved, added: preview.commitsAdded })}</p>
            {preview.mode === "soft" && <p>{t("rs.soft")}</p>}
            {preview.mode === "mixed" && <p>{t("rs.mixed")}</p>}
            {preview.mode === "hard" && <p>{t("rs.hard", { count: preview.affectedPaths.length, omitted: preview.omittedPathCount ? t("rs.hardOmits", { count: preview.omittedPathCount }) : "" })}</p>}
            {preview.dirtyPaths.length > 0 && <p>{t("rs.dirtyBlocks", { count: preview.dirtyPaths.length })}</p>}
            <p className="cloneHelp">{t("rs.noAi")}</p>
          </section>
          {!preview.canStart && <p className="taskCenterError" role="alert">{t("rs.cannotStart")}</p>}
          <div className="resetAffectedPaths"><strong>{t("rs.affected", { count: preview.affectedPaths.length, omitted: preview.omittedPathCount ? t("rs.omittedSuffix", { count: preview.omittedPathCount }) : "" })}</strong>
            {preview.affectedPaths.length ? <ul>{preview.affectedPaths.map((path) => <li key={path} className="monoText">{path}</li>)}</ul> : <p className="cloneHelp">{t("rs.noDiff")}</p>}
          </div>
          {preview.dirtyPaths.length > 0 && <p className="cloneHelp">{t("rs.localPresent", { count: preview.dirtyPaths.length })}</p>}
          <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t("rs.reviewedConfirm")}</label>
        </>}

      <details className="rebaseRollbackPanel resetRecovery"><summary id="reset-restore-heading">{t("rs.restoreHeading")}</summary>

          {backupSnapshot?.backups.length ? <>
            <label className="rebaseTargetField" htmlFor="reset-backup">{t("rs.savedState")}
              <select id="reset-backup" value={selectedBackup} disabled={disabled || busy} onChange={(event) => { setSelectedBackup(event.target.value); setConfirmRestore(false); }}>
                {backupSnapshot.backups.map((backup) => <option key={backup.reference} value={backup.reference}>{backup.subject || t("push.noSubject")} · {backup.oid.slice(0, 9)}</option>)}
              </select>
            </label>
            {!backupSnapshot.canRestore && <p className="cloneHelp">{t("rs.restoreOnly")}</p>}
            <label className="rebaseConfirm"><input type="checkbox" checked={confirmRestore} onChange={(event) => setConfirmRestore(event.target.checked)} />{t("rs.restoreConfirm")}</label>
            <Button variant="danger" size="compact" type="button" disabled={!backupSnapshot.canRestore || !confirmRestore || disabled || busy} onClick={() => void restore()}>{busy ? t("rs.starting") : t("rs.restoreBtn")}</Button>
          </> : <p className="cloneHelp">{t("rs.noBackups")}</p>}
        </details>
</div>
      <DialogFooter className="taskCenterActions"><Button variant="secondary" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant={preview ? "quiet" : "primary"} type="button" disabled={!targetOid || disabled || loading || busy} onClick={() => void inspect()}>{loading ? t("rs.reviewingBtn") : t("rs.review")}</Button>
          <Button variant="danger" type="button" disabled={!preview?.canStart || !confirmed || disabled || busy} onClick={() => void start()}>{busy ? t("rs.starting") : t("rs.start", { mode })}</Button>
        </DialogFooter>
    </Dialog>;
}
