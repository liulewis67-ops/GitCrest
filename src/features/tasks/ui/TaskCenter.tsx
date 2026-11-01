import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GitCrestApiClient, RepositoryResponse, TaskSnapshotResponse, WorkflowRecoveryPreflightResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { isAuthenticationFailure, isFailedPush, isSigningFailure, supportsWorkflowRecovery } from "../model/task-operations";
import { groupTasksByRepository, taskOperationLabel, taskOutcome, taskPhaseLabel, taskRelativeTime } from "../model/task-presentation";

interface TaskCenterProps {
  tasks: TaskSnapshotResponse[];
  repositories?: RepositoryResponse[];
  error: DisplayError;
  actionId: string;
  onClose: () => void;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
  onCopy: (task: TaskSnapshotResponse) => void;
  onRetryClone: (task: TaskSnapshotResponse) => void;
  onConfigureCredentials: (task: TaskSnapshotResponse) => void;
  /** Opens the signing section of Settings; absent when it cannot be shown. */
  onOpenSigningSettings?: () => void;
  onReviewPush: (task: TaskSnapshotResponse) => void;
  api?: GitCrestApiClient;
  onRecoverWorkflow: (task: TaskSnapshotResponse, preflight: WorkflowRecoveryPreflightResponse, action: "continue" | "skip" | "abort") => void;
  onOpenConflictWindow: (task: TaskSnapshotResponse) => void;
  /** Extra content shown above the task list, such as pipeline runs. */
  extra?: ReactNode;
}

export function TaskCenter({ tasks, repositories = [], error, actionId, onClose, onRefresh, onCancel, onCopy, onRetryClone, onConfigureCredentials, onOpenSigningSettings, onReviewPush, api, onRecoverWorkflow, onOpenConflictWindow, extra }: TaskCenterProps) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [recovery, setRecovery] = useState<Record<string, { loading: boolean; snapshot?: WorkflowRecoveryPreflightResponse; error?: DisplayError }>>({});
  const [confirmAbortId, setConfirmAbortId] = useState("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose);
  const recoveryControllers = useRef(new Map<string, AbortController>());
  const waitingTaskIds = useRef(new Set<string>());
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const waitingTasks = tasks.filter((task) => task.status === "waitingForInput" && supportsWorkflowRecovery(task.operation) && task.repoId);
  const recoveryKey = waitingTasks.map((task) => `${task.taskId}:${task.repoId}`).sort().join("|");
  waitingTaskIds.current = new Set(waitingTasks.map((task) => task.taskId));

  function refreshRecoveryPreview(task: TaskSnapshotResponse) {
    if (!api || !task.repoId) return;
    recoveryControllers.current.get(task.taskId)?.abort();
    const controller = new AbortController();
    recoveryControllers.current.set(task.taskId, controller);
    setRecovery((current) => ({ ...current, [task.taskId]: { loading: true } }));
    void api.withSignal(controller.signal).preflightRepositoryWorkflowRecovery(task.repoId, task.taskId).then((snapshot) => {
      if (!controller.signal.aborted && waitingTaskIds.current.has(task.taskId)) {
        setRecovery((current) => ({ ...current, [task.taskId]: { loading: false, snapshot } }));
      }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && waitingTaskIds.current.has(task.taskId)) {
        setRecovery((current) => ({ ...current, [task.taskId]: { loading: false, error: describeApiError(reason, t("tk.recoveryFailed")) } }));
      }
    }).finally(() => {
      if (recoveryControllers.current.get(task.taskId) === controller) recoveryControllers.current.delete(task.taskId);
    });
  }

  useEffect(() => {
    const currentWaitingTasks = tasksRef.current.filter((task) => task.status === "waitingForInput" && supportsWorkflowRecovery(task.operation) && task.repoId);
    if (!api || currentWaitingTasks.length === 0) {
      setRecovery({});
      return;
    }
    setRecovery((current) => Object.fromEntries(currentWaitingTasks.map((task) => [task.taskId, current[task.taskId] || { loading: true }])));
    currentWaitingTasks.forEach(refreshRecoveryPreview);
    const refreshAfterWindowFocus = () => currentWaitingTasks.forEach(refreshRecoveryPreview);
    window.addEventListener("focus", refreshAfterWindowFocus);
    return () => {
      window.removeEventListener("focus", refreshAfterWindowFocus);
      for (const controller of recoveryControllers.current.values()) controller.abort();
      recoveryControllers.current.clear();
    };
  }, [api, recoveryKey]);
  return (
    <div className="paletteBackdrop taskBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="taskCenter" role="dialog" aria-modal="true" aria-labelledby="task-center-title" onKeyDown={onKeyDown}>
        <div className="taskCenterHeader">
          <div><h2 id="task-center-title">{t("tk.title")}</h2></div>
          <div className="taskCenterActions">
            <button className="quietButton compact" type="button" onClick={onRefresh}>{t("tk.refresh")}</button>
            <button className="quietButton compact" type="button" onClick={onClose} aria-label={t("tk.closeAria")}>{t("tk.close")}</button>
          </div>
        </div>
        {error && <p role="alert" className="taskCenterError"><ErrorMessage error={error} /></p>}
        {extra}
        {tasks.length === 0 ? <p className="taskCenterEmpty">{t("tk.empty")}</p> : (
          <div className="taskList">
            {groupTasksByRepository(tasks, repositories).map((group) => <section className="taskRepositoryGroup" key={group.key} aria-label={group.name}>
              <h3>{group.name}</h3>
              {group.tasks.map((task) => (
              <article className="taskCard" key={task.taskId}>
                <div className="taskCardHeading"><strong data-operation={task.operation}>{taskOperationLabel(task.operation)}</strong><span className={`taskStatus task-${task.status}`} data-status={task.status} role={task.status === "running" ? "status" : undefined}>{t(`tk.status.${task.status}`)}</span></div>
                <p className="taskOutcome">{taskOutcome(task)}</p>
                <div className="taskCardMeta">{(task.status === "running" || task.status === "queued" || task.status === "waitingForInput") && <span>{taskPhaseLabel(task.phase)}</span>}{(task.status === "running" || task.status === "queued") && task.progress !== null && <span>{task.progress}%</span>}<time dateTime={new Date(task.updatedAtMs).toISOString()} title={new Date(task.updatedAtMs).toLocaleString()}>{taskRelativeTime(task.updatedAtMs, now)}</time></div>
                {(task.status === "running" || task.status === "queued") && task.progress !== null && <progress max={100} value={task.progress} aria-label={t("tk.progressAria", { op: taskOperationLabel(task.operation) })} />}
                {task.errorCategory && <p className="taskMessage">{t(`tk.error.${task.errorCategory}`)}</p>}
                {task.operation === "clone" && (task.status === "failed" || task.status === "cancelled") && <><p className="cloneHelp">{t("tk.cloneHelp")}</p><button className="textButton taskCancelButton" type="button" onClick={() => onRetryClone(task)}>{t("tk.retryClone")}</button></>}
                {isAuthenticationFailure(task) && <div className="taskCredentialRecovery"><p className="cloneHelp">{t("tk.updateCred")}</p><button className="secondaryButton" type="button" onClick={() => onConfigureCredentials(task)}>{t("tk.configCred")}</button></div>}
                {isSigningFailure(task) && <div className="taskCredentialRecovery"><p className="cloneHelp">{t("tk.signingFailed")}</p>{onOpenSigningSettings && <button className="secondaryButton" type="button" onClick={onOpenSigningSettings}>{t("tk.signingSettings")}</button>}</div>}
                {isFailedPush(task) && <div className="taskCredentialRecovery"><p className="cloneHelp">{task.errorCategory === "pushRejected" ? t("tk.pushRejected") : t("tk.commitSaved")} {t("tk.forceNote")}</p><button className="secondaryButton" type="button" onClick={() => onReviewPush(task)}>{t("tk.reviewPush")}</button></div>}
                {task.status === "waitingForInput" && supportsWorkflowRecovery(task.operation) && <div className="taskCredentialRecovery workflowRecovery"><p className="cloneHelp">{t("tk.resolveListed")}</p>
                  {recovery[task.taskId]?.loading && <p role="status">{t("tk.inspecting")}</p>}
                  {recovery[task.taskId]?.error && <p className="taskCenterError" role="alert"><ErrorMessage error={recovery[task.taskId]?.error} /></p>}
                  {recovery[task.taskId]?.snapshot && <>
                    {recovery[task.taskId]!.snapshot!.conflictedPaths.length > 0 && <button className="secondaryButton" type="button" onClick={() => onOpenConflictWindow(task)}>{t("tk.openResolver")}</button>}
                    {recovery[task.taskId]!.snapshot!.conflictedPaths.length > 0 ? <ul className="workflowPathList" aria-label={t("tk.conflictedFiles")}>{recovery[task.taskId]!.snapshot!.conflictedPaths.map((path) => <li key={path} title={path}>{path}</li>)}</ul> : <p className="cloneHelp">{t("tk.noneLeft")}</p>}
                    {recovery[task.taskId]!.snapshot!.omittedConflictedPathCount > 0 && <p className="cloneHelp">{t("tk.andMore", { count: recovery[task.taskId]!.snapshot!.omittedConflictedPathCount })}</p>}
                    <div className="taskCenterActions"><button className="quietButton compact" type="button" onClick={() => refreshRecoveryPreview(task)}>{t("tk.refreshPreview")}</button>
                      <button className="secondaryButton" type="button" disabled={!recovery[task.taskId]!.snapshot!.canContinue || actionId === task.taskId} onClick={() => onRecoverWorkflow(task, recovery[task.taskId]!.snapshot!, "continue")}>{t("tk.continue")}</button>
                      {(task.operation === "cherryPick" || task.operation === "revert" || task.operation === "rebase") && <button className="secondaryButton" type="button" disabled={!recovery[task.taskId]!.snapshot!.canSkip || actionId === task.taskId} onClick={() => onRecoverWorkflow(task, recovery[task.taskId]!.snapshot!, "skip")}>{t("tk.skip")}</button>}
                      {confirmAbortId === task.taskId ? <><span className="cloneHelp">{t("tk.abortQ")}</span><button className="textButton" type="button" disabled={!recovery[task.taskId]!.snapshot!.canAbort || actionId === task.taskId} onClick={() => { onRecoverWorkflow(task, recovery[task.taskId]!.snapshot!, "abort"); setConfirmAbortId(""); }}>{t("tk.confirmAbort")}</button><button className="textButton" type="button" onClick={() => setConfirmAbortId("")}>{t("tk.keepResolving")}</button></> : <button className="textButton" type="button" disabled={!recovery[task.taskId]!.snapshot!.canAbort || actionId === task.taskId} onClick={() => setConfirmAbortId(task.taskId)}>{t("tk.abort")}</button>}</div>
                  </>}
                </div>}
                <details className="taskLogs"><summary>{t("tk.logSummary", { count: task.logs.length })}</summary><pre>{[task.message, ...task.logs].filter(Boolean).join("\n") || t("tk.noLog")}</pre><button className="textButton" type="button" disabled={task.logs.length === 0} onClick={() => onCopy(task)}>{t("tk.copyLog")}</button></details>
                {(task.status === "queued" || task.status === "running") && <button className="textButton taskCancelButton" type="button" disabled={task.cancelRequested || actionId === task.taskId} onClick={() => onCancel(task.taskId)}>{task.cancelRequested ? t("tk.stopping") : actionId === task.taskId ? t("tk.requesting") : t("tk.cancel")}</button>}
              </article>
            ))}</section>)}
          </div>
        )}
      </section>
    </div>
  );
}
