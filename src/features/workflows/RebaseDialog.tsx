import { useEffect, useMemo, useState } from "react";
import {
  GitCrestApiError,
  type BranchSnapshotResponse,
  type GitCrestApiClient,
  type RebasePreviewResponse,
  type RebaseBackupSnapshotResponse,
  type TaskSnapshotResponse,
} from "../../api/client";
import type { components } from "../../api/schema";
import { useDialogFocus } from "../../shared/use-dialog-focus";

type RebaseTodoItem = components["schemas"]["RebaseTodoItem"];

const ACTIONS: RebaseTodoItem["action"][] = ["pick", "reword", "edit", "squash", "fixup", "drop"];

export function RebaseDialog({ api, repoId, branches, disabled, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  branches?: BranchSnapshotResponse;
  disabled: boolean;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const targets = useMemo(
    () => (branches?.branches || []).filter((branch) => !branch.isCurrent),
    [branches],
  );
  const currentBranch = branches?.branches.find((branch) => branch.isCurrent);
  const defaultTarget = targets.find((branch) => branch.fullName === currentBranch?.upstream) || targets[0];
  const [ontoOid, setOntoOid] = useState("");
  const [preview, setPreview] = useState<RebasePreviewResponse>();
  const [backupSnapshot, setBackupSnapshot] = useState<RebaseBackupSnapshotResponse>();
  const [selectedBackup, setSelectedBackup] = useState("");
  const [todo, setTodo] = useState<RebaseTodoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [confirmPublishedRewrite, setConfirmPublishedRewrite] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [error, setError] = useState("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);

  useEffect(() => {
    let active = true;
    void api.getRepositoryRebaseBackups(repoId).then((snapshot) => {
      if (!active) return;
      setBackupSnapshot(snapshot);
      setSelectedBackup(snapshot.backups[0]?.reference || "");
    }).catch((reason) => {
      if (active) setError(reason instanceof GitCrestApiError ? reason.body.error.message : "Could not load rebase backups.");
    });
    return () => { active = false; };
  }, [api, repoId]);

  useEffect(() => {
    if (!ontoOid && defaultTarget) setOntoOid(defaultTarget.oid);
  }, [defaultTarget, ontoOid]);

  const dropCount = todo.filter((item) => item.action === "drop").length;
  const canStart = Boolean(
    preview?.canStart
      && preview.headOid
      && !disabled
      && !loading
      && !busy
      && (!dropCount || confirmDrop)
      && (!(preview.publishedCommitOids?.length) || confirmPublishedRewrite),
  );

  async function inspect() {
    if (!ontoOid || disabled || loading || busy) return;
    setLoading(true);
    setError("");
    setPreview(undefined);
    setTodo([]);
    setConfirmDrop(false);
    setConfirmPublishedRewrite(false);
    try {
      const next = await api.preflightRepositoryRebase(repoId, ontoOid);
      setPreview(next);
      setTodo(next.commits.map((commit) => ({ oid: commit.oid, action: "pick", message: null })));
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not inspect this rebase.");
    } finally {
      setLoading(false);
    }
  }

  function updateTodo(index: number, update: Partial<RebaseTodoItem>) {
    setTodo((current) => current.map((item, position) => position === index ? { ...item, ...update } : item));
  }

  function moveTodo(index: number, delta: -1 | 1) {
    const nextIndex = index + delta;
    setTodo((current) => {
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[nextIndex]] = [reordered[nextIndex]!, reordered[index]!];
      return reordered;
    });
  }

  async function start() {
    if (!canStart || !preview?.headOid) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.startRepositoryRebase(repoId, {
        expectedHeadOid: preview.headOid,
        expectedOntoOid: preview.ontoOid,
        previewRevision: preview.previewRevision,
        todo,
        confirmDrop,
        confirmPublishedRewrite,
      }));
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not start this rebase.");
    } finally {
      setBusy(false);
    }
  }

  async function rollback() {
    const backup = backupSnapshot?.backups.find((item) => item.reference === selectedBackup);
    if (!backupSnapshot?.canRollback || !backupSnapshot.headOid || !backup || !confirmRollback || disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.rollbackRepositoryRebase(repoId, {
        expectedHeadOid: backupSnapshot.headOid,
        backupReference: backup.reference,
        backupOid: backup.oid,
        confirmRollback: true,
      }));
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not start rollback.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter rebaseDialog" role="dialog" aria-modal="true" aria-labelledby="rebase-dialog-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">REVIEW HISTORY REWRITE</p><h2 id="rebase-dialog-title">Interactive rebase</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>Close</button>
      </div>
      <div className="workflowDialogBody">
        <label className="rebaseTargetField" htmlFor="rebase-onto">Rebase current branch onto
          <select id="rebase-onto" value={ontoOid} disabled={disabled || loading || busy || targets.length === 0} onChange={(event) => { setOntoOid(event.target.value); setPreview(undefined); setTodo([]); }}>
            {targets.map((branch) => <option key={`${branch.fullName}:${branch.oid}`} value={branch.oid}>{branch.fullName} · {branch.oid.slice(0, 9)}</option>)}
          </select>
        </label>
        {targets.length === 0 && <p className="cloneHelp">There is no other local or remote-tracking branch to use as a target.</p>}
        {disabled && <p className="cloneHelp">Wait for the current repository task to finish before starting a rebase.</p>}
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <section className="rebaseRollbackPanel" aria-labelledby="rebase-rollback-heading">
          <h3 id="rebase-rollback-heading">Restore a rebase backup</h3>
          {backupSnapshot?.backups.length ? <>
            <label className="rebaseTargetField" htmlFor="rebase-backup">Saved branch state
              <select id="rebase-backup" value={selectedBackup} disabled={disabled || busy} onChange={(event) => { setSelectedBackup(event.target.value); setConfirmRollback(false); }}>
                {backupSnapshot.backups.map((backup) => <option key={backup.reference} value={backup.reference}>{backup.subject || "(no subject)"} · {backup.oid.slice(0, 9)}</option>)}
              </select>
            </label>
            {!backupSnapshot.canRollback && <p className="cloneHelp">Rollback is available only on a clean attached branch with no Git operation in progress.</p>}
            <label className="rebaseConfirm"><input type="checkbox" checked={confirmRollback} onChange={(event) => setConfirmRollback(event.target.checked)} />I understand restoring this backup moves the current branch and replaces its checked-out files.</label>
            <button className="quietButton compact" type="button" disabled={!backupSnapshot.canRollback || !confirmRollback || disabled || busy} onClick={() => void rollback()}>{busy ? "Starting…" : "Restore selected backup"}</button>
          </> : <p className="cloneHelp">No GitCrest rebase backups are available in this repository.</p>}
        </section>
        {loading && <p role="status">Reviewing the commit range…</p>}
        {preview && <>
          <div className="rebasePreviewFacts">
            <div className="repositoryFact"><span>BRANCH</span><strong>{preview.currentBranch || "Detached HEAD"}</strong></div>
            <div className="repositoryFact"><span>HEAD</span><strong className="monoText">{preview.headOid?.slice(0, 12) || "Unborn"}</strong></div>
            <div className="repositoryFact"><span>ONTO</span><strong className="monoText">{preview.ontoOid.slice(0, 12)}</strong></div>
            <div className="repositoryFact"><span>COMMITS</span><strong>{preview.commits.length}{preview.omittedCommitCount ? ` + ${preview.omittedCommitCount} omitted` : ""}</strong></div>
          </div>
          <section className="operationImpactNotice" aria-label="Rebase impact explanation">
            <h3>What this rebase will change</h3>
            <p><strong>{preview.currentBranch || "Detached HEAD"}</strong> will replay the reviewed todo onto <code>{preview.ontoOid.slice(0, 12)}</code>. Review the action and order shown below; the todo currently contains {todo.length} commit(s){preview.omittedCommitCount ? ` and ${preview.omittedCommitCount} additional commit(s) were omitted from this bounded preview` : ""}.</p>
            {dropCount > 0 && <p>{dropCount} commit(s) marked drop will not be replayed.</p>}
            {preview.publishedCommitOids.length > 0 && <p>{preview.publishedCommitOids.length} previewed commit(s) are already reachable from remote-tracking refs and may receive new OIDs when rewritten.</p>}
            {preview.dirtyPaths.length > 0 && <p>{preview.dirtyPaths.length} local changed path(s) are present; the rebase is not available until the worktree is clean.</p>}
            <p>A rollback ref is created before execution. This deterministic summary uses the current preview and edited todo, even when an AI provider is unavailable.</p>
          </section>
          {!preview.canStart && <p className="taskCenterError" role="alert">This branch cannot be rebased in its current state. Check for a dirty worktree, active operation, detached HEAD, or an oversized commit range.</p>}
          {preview.publishedCommitOids.length > 0 && <label className="rebaseConfirm"><input type="checkbox" checked={confirmPublishedRewrite} onChange={(event) => setConfirmPublishedRewrite(event.target.checked)} />I understand this rewrites {preview.publishedCommitOids.length} commit(s) already reachable from a remote-tracking branch.</label>}
          <ol className="rebaseTodoList" aria-label="Rebase todo">
            {todo.map((item, index) => {
              const commit = preview.commits.find((entry) => entry.oid === item.oid);
              return <li key={item.oid}>
                <div className="rebaseTodoRow">
                  <span className="monoText rebaseTodoOid">{item.oid.slice(0, 9)}</span>
                  <select aria-label={`Action for ${item.oid.slice(0, 9)}`} value={item.action} disabled={busy} onChange={(event) => updateTodo(index, { action: event.target.value as RebaseTodoItem["action"], message: event.target.value === "reword" ? item.message || commit?.subject || "" : null })}>
                    {ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
                  </select>
                  <span className="rebaseTodoSubject" title={commit?.subject}>{commit?.subject || "(no subject)"}</span>
                  <button className="quietButton compact" type="button" aria-label={`Move ${item.oid.slice(0, 9)} up`} disabled={busy || index === 0} onClick={() => moveTodo(index, -1)}>↑</button>
                  <button className="quietButton compact" type="button" aria-label={`Move ${item.oid.slice(0, 9)} down`} disabled={busy || index === todo.length - 1} onClick={() => moveTodo(index, 1)}>↓</button>
                </div>
                {item.action === "reword" && <textarea className="rebaseMessage" aria-label={`Replacement message for ${item.oid.slice(0, 9)}`} value={item.message || ""} disabled={busy} onChange={(event) => updateTodo(index, { message: event.target.value })} rows={3} />}
              </li>;
            })}
          </ol>
          {dropCount > 0 && <label className="rebaseConfirm"><input type="checkbox" checked={confirmDrop} onChange={(event) => setConfirmDrop(event.target.checked)} />I understand {dropCount} dropped commit(s) will not be replayed.</label>}
        </>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={!ontoOid || disabled || loading || busy} onClick={() => void inspect()}>{loading ? "Reviewing…" : "Refresh preview"}</button>
          <button className="primaryButton" type="button" disabled={!canStart} onClick={() => void start()}>{busy ? "Starting…" : "Start rebase"}</button>
        </div>
        {preview && <p className="cloneHelp">A rollback ref is created before execution. The task log shows its name.</p>}
      </div>
    </section>
  </div>;
}
