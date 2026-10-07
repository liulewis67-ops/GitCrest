import type { TaskSnapshotResponse } from "../../api/client";

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
}

function isAuthenticationFailure(task: TaskSnapshotResponse): boolean {
  if (task.status !== "failed" || task.operation !== "fetch") return false;
  return /authentication failed|authentication required|could not read username|could not read password|access denied|terminal prompts disabled/i.test([task.message, ...task.logs].join("\n"));
}

export function TaskCenter({ tasks, error, actionId, onClose, onRefresh, onCancel, onCopy, onRetryClone, onConfigureCredentials }: TaskCenterProps) {
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
