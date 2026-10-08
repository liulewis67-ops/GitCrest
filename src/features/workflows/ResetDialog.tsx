import { useEffect, useState } from "react";
import { GitCrestApiError, type BranchSnapshotResponse, type GitCrestApiClient, type ResetBackupSnapshotResponse, type ResetPreviewResponse, type TaskSnapshotResponse } from "../../api/client";
import type { components } from "../../api/schema";

type ResetMode = components["schemas"]["ResetMode"];
const MODES: ResetMode[] = ["soft", "mixed", "hard"];

export function ResetDialog({ api, repoId, branches, disabled, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  branches?: BranchSnapshotResponse;
  disabled: boolean;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const current = branches?.branches.find((branch) => branch.isCurrent);
  const targets = (branches?.branches || []).filter((branch) => !branch.isCurrent && branch.oid !== current?.oid);
  const [targetOid, setTargetOid] = useState("");
  const [mode, setMode] = useState<ResetMode>("mixed");
  const [preview, setPreview] = useState<ResetPreviewResponse>();
  const [backupSnapshot, setBackupSnapshot] = useState<ResetBackupSnapshotResponse>();
  const [selectedBackup, setSelectedBackup] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api.getRepositoryResetBackups(repoId).then((snapshot) => {
      if (!active) return;
      setBackupSnapshot(snapshot);
      setSelectedBackup(snapshot.backups[0]?.reference || "");
    }).catch((reason) => {
      if (active) setError(reason instanceof GitCrestApiError ? reason.body.error.message : "Could not load reset recovery references.");
    });
    return () => { active = false; };
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
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not inspect this reset.");
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
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not start this reset.");
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
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not start restore.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="taskCenter resetDialog" role="dialog" aria-modal="true" aria-labelledby="reset-dialog-title">
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">REVIEW BRANCH MOVEMENT</p><h2 id="reset-dialog-title">Reset current branch</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>Close</button>
      </div>
      <div className="workflowDialogBody">
        <label className="rebaseTargetField" htmlFor="reset-target">Move {current?.fullName || "current branch"} to
          <select id="reset-target" value={targetOid} disabled={disabled || loading || busy} onChange={(event) => { setTargetOid(event.target.value); setPreview(undefined); setConfirmed(false); }}>
            <option value="">Choose a branch commit…</option>
            {targets.map((branch) => <option key={`${branch.fullName}:${branch.oid}`} value={branch.oid}>{branch.fullName} · {branch.oid.slice(0, 9)}</option>)}
          </select>
        </label>
        <label className="rebaseTargetField" htmlFor="reset-mode">Reset mode
          <select id="reset-mode" value={mode} disabled={disabled || loading || busy} onChange={(event) => { setMode(event.target.value as ResetMode); setPreview(undefined); setConfirmed(false); }}>
            {MODES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <p className="cloneHelp">Soft moves HEAD and keeps the index and files. Mixed moves HEAD and resets the index while keeping files. Hard also replaces tracked files and is available only when the working tree is clean.</p>
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <section className="rebaseRollbackPanel" aria-labelledby="reset-restore-heading">
          <h3 id="reset-restore-heading">Restore a reset backup</h3>
          {backupSnapshot?.backups.length ? <>
            <label className="rebaseTargetField" htmlFor="reset-backup">Saved branch state
              <select id="reset-backup" value={selectedBackup} disabled={disabled || busy} onChange={(event) => { setSelectedBackup(event.target.value); setConfirmRestore(false); }}>
                {backupSnapshot.backups.map((backup) => <option key={backup.reference} value={backup.reference}>{backup.subject || "(no subject)"} · {backup.oid.slice(0, 9)}</option>)}
              </select>
            </label>
            {!backupSnapshot.canRestore && <p className="cloneHelp">Restore is available only on a clean attached branch with no Git operation in progress.</p>}
            <label className="rebaseConfirm"><input type="checkbox" checked={confirmRestore} onChange={(event) => setConfirmRestore(event.target.checked)} />I understand restoring the saved state replaces the current branch and checked-out files. A safety backup will be created first.</label>
            <button className="quietButton compact" type="button" disabled={!backupSnapshot.canRestore || !confirmRestore || disabled || busy} onClick={() => void restore()}>{busy ? "Starting…" : "Restore selected reset backup"}</button>
          </> : <p className="cloneHelp">No reset recovery references are available in this repository.</p>}
        </section>
        {loading && <p role="status">Reviewing reset impact…</p>}
        {preview && <>
          <div className="rebasePreviewFacts">
            <div className="repositoryFact"><span>BRANCH</span><strong>{preview.currentBranch}</strong></div>
            <div className="repositoryFact"><span>MODE</span><strong>{preview.mode}</strong></div>
            <div className="repositoryFact"><span>COMMITS</span><strong>{preview.commitsRemoved} removed · {preview.commitsAdded} added</strong></div>
            <div className="repositoryFact"><span>TARGET</span><strong className="monoText">{preview.targetOid.slice(0, 12)}</strong></div>
          </div>
          <section className="operationImpactNotice" aria-label="Reset impact explanation">
            <h3>What this reset will change</h3>
            <p><strong>{preview.currentBranch}</strong> moves from <code>{preview.expectedHeadOid.slice(0, 12)}</code> to <code>{preview.targetOid.slice(0, 12)}</code>, removing {preview.commitsRemoved} commit(s) from the current branch history and adding {preview.commitsAdded} target commit(s).</p>
            {preview.mode === "soft" && <p>Soft reset keeps the index and checked-out files as they are.</p>}
            {preview.mode === "mixed" && <p>Mixed reset replaces the index with the target tree and keeps checked-out files as they are.</p>}
            {preview.mode === "hard" && <p>Hard reset replaces tracked checked-out files with the target tree. The preview reports {preview.affectedPaths.length} changed path(s){preview.omittedPathCount ? ` and omits ${preview.omittedPathCount} more` : ""}.</p>}
            {preview.dirtyPaths.length > 0 && <p>{preview.dirtyPaths.length} local changed path(s) are present; this preview does not permit hard reset over them.</p>}
            <p className="cloneHelp">This explanation is generated from the current reset preview and remains available without an AI provider.</p>
          </section>
          {!preview.canStart && <p className="taskCenterError" role="alert">This reset cannot start. The target may already be HEAD, a Git operation may be active, or hard reset may overwrite local changes.</p>}
          <div className="resetAffectedPaths"><strong>Affected paths ({preview.affectedPaths.length}{preview.omittedPathCount ? ` + ${preview.omittedPathCount} omitted` : ""})</strong>
            {preview.affectedPaths.length ? <ul>{preview.affectedPaths.map((path) => <li key={path} className="monoText">{path}</li>)}</ul> : <p className="cloneHelp">No tracked paths differ between HEAD and the target.</p>}
          </div>
          {preview.dirtyPaths.length > 0 && <p className="cloneHelp">Local changes present: {preview.dirtyPaths.length} path(s). Soft and mixed preserve working files; hard reset is disabled.</p>}
          <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the commit and path impact. A recovery ref will be created before moving this branch.</label>
        </>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={!targetOid || disabled || loading || busy} onClick={() => void inspect()}>{loading ? "Reviewing…" : "Review impact"}</button>
          <button className="dangerTextButton" type="button" disabled={!preview?.canStart || !confirmed || disabled || busy} onClick={() => void start()}>{busy ? "Starting…" : `Reset ${mode}`}</button>
        </div>
      </div>
    </section>
  </div>;
}
