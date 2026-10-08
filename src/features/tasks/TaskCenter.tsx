import { useEffect, useRef, useState } from "react";
import type { GitCrestApiClient, TaskSnapshotResponse, WorkflowRecoveryPreflightResponse } from "../../api/client";

interface TaskCenterProps {
  tasks: TaskSnapshotResponse[];
  error: string;
  actionId: string;
  onClose: () => void;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
  onCopy: (task: TaskSnapshotResponse) => void;
  onRetryClone: (task: TaskSnapshotResponse) => void;
  onConfigureCredentials: (task: TaskSnapshotResponse) => void;
  onReviewPush: (task: TaskSnapshotResponse) => void;
  api?: GitCrestApiClient;
  onRecoverWorkflow: (task: TaskSnapshotResponse, preflight: WorkflowRecoveryPreflightResponse, action: "continue" | "skip" | "abort") => void;
  onOpenConflictWindow: (task: TaskSnapshotResponse) => void;
}

function isAuthenticationFailure(task: TaskSnapshotResponse): boolean {
  if (task.status !== "failed" || task.operation !== "fetch") return false;
  if (task.errorCategory === "authentication") return true;
  return /authentication failed|authentication required|could not read username|could not read password|access denied|terminal prompts disabled/i.test([task.message, ...task.logs].join("\n"));
}

function isFailedPush(task: TaskSnapshotResponse): boolean {
  return task.status === "failed" && task.operation.startsWith("push");
}

export function TaskCenter({ tasks, error, actionId, onClose, onRefresh, onCancel, onCopy, onRetryClone, onConfigureCredentials, onReviewPush, api, onRecoverWorkflow, onOpenConflictWindow }: TaskCenterProps) {
  const [recovery, setRecovery] = useState<Record<string, { loading: boolean; snapshot?: WorkflowRecoveryPreflightResponse; error?: string }>>({});
  const [confirmAbortId, setConfirmAbortId] = useState("");
  const queriedRecoveryTasks = useRef(new Set<string>());
  const waitingTaskIds = useRef(new Set<string>());
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const waitingTasks = tasks.filter((task) => task.status === "waitingForInput" && (["merge", "cherryPick", "revert"].includes(task.operation) || task.operation.startsWith("shelfApply:")) && task.repoId);
  const recoveryKey = waitingTasks.map((task) => `${task.taskId}:${task.repoId}`).sort().join("|");
  waitingTaskIds.current = new Set(waitingTasks.map((task) => task.taskId));

  useEffect(() => {
    const currentWaitingTasks = tasksRef.current.filter((task) => task.status === "waitingForInput" && (["merge", "cherryPick", "revert"].includes(task.operation) || task.operation.startsWith("shelfApply:")) && task.repoId);
    if (!api || currentWaitingTasks.length === 0) {
      setRecovery({});
      return;
    }
    setRecovery((current) => Object.fromEntries(currentWaitingTasks.map((task) => [task.taskId, current[task.taskId] || { loading: true }])));
    const refreshPreview = (task: TaskSnapshotResponse) => {
      setRecovery((current) => ({ ...current, [task.taskId]: { loading: true } }));
      void api.preflightRepositoryWorkflowRecovery(task.repoId!, task.taskId).then((snapshot) => {
        if (waitingTaskIds.current.has(task.taskId)) setRecovery((current) => ({ ...current, [task.taskId]: { loading: false, snapshot } }));
      }).catch((reason: unknown) => {
        if (waitingTaskIds.current.has(task.taskId)) setRecovery((current) => ({ ...current, [task.taskId]: { loading: false, error: reason instanceof Error ? reason.message : "Could not inspect workflow recovery." } }));
      });
    };
    for (const task of currentWaitingTasks) {
      if (queriedRecoveryTasks.current.has(task.taskId)) continue;
      queriedRecoveryTasks.current.add(task.taskId);
      refreshPreview(task);
    }
    const refreshAfterWindowFocus = () => currentWaitingTasks.forEach(refreshPreview);
    window.addEventListener("focus", refreshAfterWindowFocus);
    return () => window.removeEventListener("focus", refreshAfterWindowFocus);
  }, [api, recoveryKey]);
  return (
    <div className="paletteBackdrop taskBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="taskCenter" role="dialog" aria-modal="true" aria-labelledby="task-center-title">
        <div className="taskCenterHeader">
          <div><p className="sectionEyebrow">BACKGROUND WORK</p><h2 id="task-center-title">Tasks</h2></div>
          <div className="taskCenterActions">
            <button className="quietButton compact" type="button" onClick={onRefresh}>Refresh</button>
            <button className="quietButton compact" type="button" onClick={onClose} aria-label="Close tasks">Close</button>
          </div>
        </div>
        {error && <p role="alert" className="taskCenterError">{error}</p>}
        {tasks.length === 0 ? <p className="taskCenterEmpty">No background tasks in this session.</p> : (
          <div className="taskList" aria-live="polite">
            {[...tasks].reverse().map((task) => (
              <article className="taskCard" key={task.taskId}>
                <div className="taskCardHeading"><strong>{task.operation}</strong><span className={`taskStatus task-${task.status}`}>{task.status}</span></div>
                <div className="taskCardMeta"><span>{task.phase}</span>{task.progress !== null && <span>{task.progress}%</span>}<span>{task.repoId || task.targetPath || "Repository"}</span></div>
                {task.progress !== null && <progress max={100} value={task.progress} aria-label={`${task.operation} progress`} />}
                {task.message && <p className="taskMessage">{task.errorCategory && <strong>{task.errorCategory}: </strong>}{task.message}</p>}
                {task.operation === "clone" && (task.status === "failed" || task.status === "cancelled") && <><p className="cloneHelp">For HTTPS authentication failures, save a credential for the host in the clone dialog before retrying.</p><button className="textButton taskCancelButton" type="button" onClick={() => onRetryClone(task)}>Retry clone</button></>}
                {isAuthenticationFailure(task) && <div className="taskCredentialRecovery"><p className="cloneHelp">Update the saved HTTPS credential for one of this repository’s remotes, then retry the fetch.</p><button className="secondaryButton" type="button" onClick={() => onConfigureCredentials(task)}>Configure credentials</button></div>}
                {isFailedPush(task) && <div className="taskCredentialRecovery"><p className="cloneHelp">{task.errorCategory === "pushRejected" ? "The push was rejected. Fetch and review remote changes before retrying." : "The commit is still saved locally. Review the target and retry only the push when ready."} A force-with-lease action requires a fresh preview and explicit confirmation.</p><button className="secondaryButton" type="button" onClick={() => onReviewPush(task)}>Review and retry push</button></div>}
                {task.status === "waitingForInput" && (["merge", "cherryPick", "revert"].includes(task.operation) || task.operation.startsWith("shelfApply:")) && <div className="taskCredentialRecovery workflowRecovery"><p className="cloneHelp">Resolve the listed conflicts in the working tree, then refresh the recovery preview.</p>
                  {recovery[task.taskId]?.loading && <p role="status">Inspecting conflicts…</p>}
                  {recovery[task.taskId]?.error && <p className="taskCenterError" role="alert">{recovery[task.taskId]?.error}</p>}
                  {recovery[task.taskId]?.snapshot && <>
                    {recovery[task.taskId]!.snapshot!.conflictedPaths.length > 0 && <button className="secondaryButton" type="button" onClick={() => onOpenConflictWindow(task)}>Open conflict resolver</button>}
                    {recovery[task.taskId]!.snapshot!.conflictedPaths.length > 0 ? <ul className="workflowPathList" aria-label="Conflicted files">{recovery[task.taskId]!.snapshot!.conflictedPaths.map((path) => <li key={path} title={path}>{path}</li>)}</ul> : <p className="cloneHelp">No unresolved conflicts remain.</p>}
                    {recovery[task.taskId]!.snapshot!.omittedConflictedPathCount > 0 && <p className="cloneHelp">And {recovery[task.taskId]!.snapshot!.omittedConflictedPathCount} more conflicted file(s).</p>}
                    <div className="taskCenterActions"><button className="quietButton compact" type="button" onClick={() => { setRecovery((current) => ({ ...current, [task.taskId]: { loading: true } })); void api?.preflightRepositoryWorkflowRecovery(task.repoId!, task.taskId).then((snapshot) => setRecovery((current) => ({ ...current, [task.taskId]: { loading: false, snapshot } }))).catch((reason: unknown) => setRecovery((current) => ({ ...current, [task.taskId]: { loading: false, error: reason instanceof Error ? reason.message : "Could not refresh recovery preview." } }))); }}>Refresh preview</button>
                      <button className="secondaryButton" type="button" disabled={!recovery[task.taskId]!.snapshot!.canContinue || actionId === task.taskId} onClick={() => onRecoverWorkflow(task, recovery[task.taskId]!.snapshot!, "continue")}>Continue</button>
                      {(task.operation === "cherryPick" || task.operation === "revert") && <button className="secondaryButton" type="button" disabled={!recovery[task.taskId]!.snapshot!.canSkip || actionId === task.taskId} onClick={() => onRecoverWorkflow(task, recovery[task.taskId]!.snapshot!, "skip")}>Skip</button>}
                      {confirmAbortId === task.taskId ? <><span className="cloneHelp">Abort this operation?</span><button className="textButton" type="button" disabled={!recovery[task.taskId]!.snapshot!.canAbort || actionId === task.taskId} onClick={() => { onRecoverWorkflow(task, recovery[task.taskId]!.snapshot!, "abort"); setConfirmAbortId(""); }}>Confirm abort</button><button className="textButton" type="button" onClick={() => setConfirmAbortId("")}>Keep resolving</button></> : <button className="textButton" type="button" disabled={!recovery[task.taskId]!.snapshot!.canAbort || actionId === task.taskId} onClick={() => setConfirmAbortId(task.taskId)}>Abort…</button>}</div>
                  </>}
                </div>}
                <details className="taskLogs"><summary>Sanitized log · {task.logs.length} lines</summary><pre>{task.logs.join("\n") || "No log output."}</pre><button className="textButton" type="button" disabled={task.logs.length === 0} onClick={() => onCopy(task)}>Copy log</button></details>
                {(task.status === "queued" || task.status === "running") && <button className="textButton taskCancelButton" type="button" disabled={task.cancelRequested || actionId === task.taskId} onClick={() => onCancel(task.taskId)}>{task.cancelRequested ? "Stopping safely…" : actionId === task.taskId ? "Requesting cancellation…" : "Cancel task"}</button>}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
