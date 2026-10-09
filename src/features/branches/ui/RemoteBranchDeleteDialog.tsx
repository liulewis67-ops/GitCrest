import { useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type RemoteBranchDeletePreviewResponse, type RemoteSnapshotResponse, type TaskSnapshotResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/use-dialog-focus";

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
  const target = resolveTarget(branchRef, remotes);
  const [preview, setPreview] = useState<RemoteBranchDeletePreviewResponse>();
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);

  async function inspect() {
    if (!target || disabled || loading || busy) return;
    setLoading(true);
    setError("");
    setConfirmed(false);
    try {
      setPreview(await api.previewRepositoryRemoteBranchDelete(repoId, target.remoteName, target.remoteBranch));
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not inspect this remote branch.");
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
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not delete this remote branch.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter remoteBranchDeleteDialog" role="dialog" aria-modal="true" aria-labelledby="remote-branch-delete-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">DELETE REMOTE REF</p><h2 id="remote-branch-delete-title">Delete remote branch</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>Close</button>
      </div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>TARGET REF</span><strong className="monoText">{branchRef}</strong></div>
        {!target && <p className="taskCenterError" role="alert">This remote-tracking ref cannot be mapped to a configured remote.</p>}
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        {loading && <p role="status">Reviewing the remote ref and affected files…</p>}
        {preview && <>
          <div className="rebasePreviewFacts">
            <div className="repositoryFact"><span>REMOTE BRANCH</span><strong>{preview.remoteName}/{preview.remoteBranch}</strong></div>
            <div className="repositoryFact"><span>TRACKING OID</span><strong className="monoText">{preview.expectedRemoteOid.slice(0, 12)}</strong></div>
            <div className="repositoryFact"><span>COMMITS ONLY THERE</span><strong>{preview.commitsOnlyOnRemote}</strong></div>
            <div className="repositoryFact"><span>FILES DIFFER FROM HEAD</span><strong>{preview.affectedPaths.length}{preview.omittedPathCount ? ` + ${preview.omittedPathCount} omitted` : ""}</strong></div>
          </div>
          <section className="operationImpactNotice" aria-label="Remote branch deletion impact explanation">
            <h3>What this deletion will change</h3>
            <p>GitCrest will delete <strong>{preview.remoteName}/{preview.remoteBranch}</strong> from the remote, using the reviewed OID <code>{preview.expectedRemoteOid.slice(0, 12)}</code> as a lease.</p>
            <p>The preview finds {preview.commitsOnlyOnRemote} commit(s) reachable only from that remote branch and {preview.affectedPaths.length} path(s) that differ from the current HEAD{preview.omittedPathCount ? `; ${preview.omittedPathCount} additional path(s) are omitted from this list` : ""}. Deleting the ref can make those commits harder to reach; it does not rewrite the current local branch.</p>
            {preview.operationInProgress && <p>A {preview.operationInProgress} operation is active, so deletion is blocked until it finishes.</p>}
            <p className="cloneHelp">This safety summary is based on the reviewed remote preview and remains available without an AI provider.</p>
          </section>
          {preview.affectedPaths.length > 0 && <ul className="resetAffectedPaths">{preview.affectedPaths.map((path) => <li key={path} className="monoText">{path}</li>)}</ul>}
          {!preview.canDelete && <p className="taskCenterError" role="alert">Finish the active Git operation before deleting a remote branch.</p>}
          <p className="cloneHelp">Deletion uses a force-with-lease check against this reviewed OID. If the remote branch moved since your last fetch, Git will refuse and the branch will remain.</p>
          <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I understand this deletes {preview.remoteName}/{preview.remoteBranch} from the remote. This cannot be undone through GitCrest.</label>
        </>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={!target || disabled || loading || busy} onClick={() => void inspect()}>{loading ? "Reviewing…" : "Review impact"}</button>
          <button className="dangerTextButton" type="button" disabled={!preview?.canDelete || !confirmed || disabled || busy} onClick={() => void remove()}>{busy ? "Starting…" : "Delete remote branch"}</button>
        </div>
      </div>
    </section>
  </div>;
}
