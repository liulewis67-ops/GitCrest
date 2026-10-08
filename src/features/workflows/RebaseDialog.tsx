import { useEffect, useMemo, useState } from "react";
import {
  GitCrestApiError,
  type BranchSnapshotResponse,
  type GitCrestApiClient,
  type RebasePreviewResponse,
  type TaskSnapshotResponse,
} from "../../api/client";
import type { components } from "../../api/schema";

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
  const [todo, setTodo] = useState<RebaseTodoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [confirmPublishedRewrite, setConfirmPublishedRewrite] = useState(false);
  const [error, setError] = useState("");

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

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="taskCenter rebaseDialog" role="dialog" aria-modal="true" aria-labelledby="rebase-dialog-title">
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
        {loading && <p role="status">Reviewing the commit range…</p>}
        {preview && <>
          <div className="rebasePreviewFacts">
            <div className="repositoryFact"><span>BRANCH</span><strong>{preview.currentBranch || "Detached HEAD"}</strong></div>
            <div className="repositoryFact"><span>HEAD</span><strong className="monoText">{preview.headOid?.slice(0, 12) || "Unborn"}</strong></div>
            <div className="repositoryFact"><span>ONTO</span><strong className="monoText">{preview.ontoOid.slice(0, 12)}</strong></div>
            <div className="repositoryFact"><span>COMMITS</span><strong>{preview.commits.length}{preview.omittedCommitCount ? ` + ${preview.omittedCommitCount} omitted` : ""}</strong></div>
          </div>
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
