import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useState } from "react";
import { type GitCrestApiClient, type RemoteBranchDeletePreviewResponse, type RemoteSnapshotResponse, type TaskSnapshotResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";

function resolveTarget(branchRef: string, remotes?: RemoteSnapshotResponse) {
  const referencePrefix = "refs/remotes/";
  if (!branchRef.startsWith(referencePrefix)) return undefined;
  const suffix = branchRef.slice(referencePrefix.length);
  const remote = [...(remotes?.remotes || [])]
    .sort((left, right) => right.name.length - left.name.length)
    .find((candidate) => suffix.startsWith(`${candidate.name}/`));
  if (!remote) return undefined;
  const branch = suffix.slice(remote.name.length + 1);
  return branch && branch !== "HEAD" ? { remoteName: remote.name, remoteBranch: branch } : undefined;
}

export function RemoteBranchDeleteDialog({ api, repoId, branchRef, remotes, disabled, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  branchRef: string;
  remotes?: RemoteSnapshotResponse;
  disabled: boolean;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const target = resolveTarget(branchRef, remotes);
  const [preview, setPreview] = useState<RemoteBranchDeletePreviewResponse>();
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);

  async function inspect() {
    if (!target || disabled || loading || busy) return;
    setLoading(true);
    setError("");
    setConfirmed(false);
    try {
      setPreview(await api.previewRepositoryRemoteBranchDelete(repoId, target.remoteName, target.remoteBranch));
    } catch (reason) {
      setError(describeApiError(reason, t("rbd.inspectFailed")));
    } finally {
      setLoading(false);
    }
  }

  async function remove() {
    if (!target || !preview?.canDelete || !confirmed || disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.deleteRepositoryRemoteBranch(repoId, {
        remoteName: preview.remoteName,
        remoteBranch: preview.remoteBranch,
        expectedRemoteOid: preview.expectedRemoteOid,
        previewRevision: preview.previewRevision,
        confirmDelete: true,
      }));
    } catch (reason) {
      setError(describeApiError(reason, t("rbd.deleteFailed")));
    } finally {
      setBusy(false);
    }
  }

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter remoteBranchDeleteDialog" role="dialog" aria-modal="true" aria-labelledby="remote-branch-delete-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">{t("rbd.eyebrow")}</p><h2 id="remote-branch-delete-title">{t("rbd.title")}</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>{t("rbd.close")}</button>
      </div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{t("rbd.targetRef")}</span><strong className="monoText">{branchRef}</strong></div>
        {!target && <p className="taskCenterError" role="alert">{t("rbd.cannotMap")}</p>}
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
        {loading && <p role="status">{t("rbd.reviewing")}</p>}
        {preview && <>
          <div className="rebasePreviewFacts">
            <div className="repositoryFact"><span>{t("rbd.remoteBranch")}</span><strong>{preview.remoteName}/{preview.remoteBranch}</strong></div>
            <div className="repositoryFact"><span>{t("rbd.trackingOid")}</span><strong className="monoText">{preview.expectedRemoteOid.slice(0, 12)}</strong></div>
            <div className="repositoryFact"><span>{t("rbd.commitsOnlyThere")}</span><strong>{preview.commitsOnlyOnRemote}</strong></div>
            <div className="repositoryFact"><span>{t("rbd.filesDiffer")}</span><strong>{preview.affectedPaths.length}{preview.omittedPathCount ? t("rbd.omittedSuffix", { count: preview.omittedPathCount }) : ""}</strong></div>
          </div>
          <section className="operationImpactNotice" aria-label={t("rbd.impactAria")}>
            <h3>{t("rbd.impactHeading")}</h3>
            <p>{t("rbd.impactLease", { ref: `${preview.remoteName}/${preview.remoteBranch}`, oid: preview.expectedRemoteOid.slice(0, 12) })}</p>
            <p>{t("rbd.impactDetail", { commits: preview.commitsOnlyOnRemote, paths: preview.affectedPaths.length, omitted: preview.omittedPathCount ? t("rbd.impactOmitted", { count: preview.omittedPathCount }) : "" })}</p>
            {preview.operationInProgress && <p>{t("rbd.opInProgress", { op: preview.operationInProgress })}</p>}
            <p className="cloneHelp">{t("rbd.safetyNote")}</p>
          </section>
          {preview.affectedPaths.length > 0 && <ul className="resetAffectedPaths">{preview.affectedPaths.map((path) => <li key={path} className="monoText">{path}</li>)}</ul>}
          {!preview.canDelete && <p className="taskCenterError" role="alert">{t("rbd.finishOp")}</p>}
          <p className="cloneHelp">{t("rbd.leaseNote")}</p>
          <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t("rbd.confirm", { ref: `${preview.remoteName}/${preview.remoteBranch}` })}</label>
        </>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={!target || disabled || loading || busy} onClick={() => void inspect()}>{loading ? t("rbd.reviewingBtn") : t("rbd.review")}</button>
          <button className="dangerTextButton" type="button" disabled={!preview?.canDelete || !confirmed || disabled || busy} onClick={() => void remove()}>{busy ? t("rbd.starting") : t("rbd.delete")}</button>
        </div>
      </div>
    </section>
  </div>;
}
