import { useEffect, useRef, useState } from "react";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../../api/client";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { Button } from "../../../shared/ui/Button";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";

export type BatchRefTarget = { id: string; name: string; detail?: string; blocked?: string; submit: () => Promise<TaskSnapshotResponse> };

/** Review the exact selection, then run serially and retain an outcome for every target. */
export function BatchRefDialog({ api, operation, targets, onClose, onChanged, onTaskStarted, returnFocus }: {
  api: GitCrestApiClient; operation: "pull" | "push" | "delete" | "remove";
  targets: BatchRefTarget[]; onClose: () => void; onChanged?: () => void;
  onTaskStarted?: (task: TaskSnapshotResponse) => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [results, setResults] = useState<Record<string, { state: "running" | "done" | "failed" | "skipped"; error?: DisplayError }>>({});
  const stopped = useRef(false);
  const activeTask = useRef<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopped.current = true; }; }, []);
  const update = (id: string, result: typeof results[string]) => {
    if (mounted.current) setResults(previous => ({ ...previous, [id]: result }));
  };
  async function run() {
    if (running || finished) return;
    setRunning(true);
    stopped.current = false;
    for (const target of targets) {
      if (stopped.current || target.blocked) { update(target.id, { state: "skipped" }); continue; }
      update(target.id, { state: "running" });
      try {
        let task = await target.submit();
        activeTask.current = task.taskId;
        onTaskStarted?.(task);
        while (["queued", "running"].includes(task.status)) {
          await new Promise(resolve => setTimeout(resolve, 300));
          if (!mounted.current) return;
          const latest = (await api.listTasks().catch(reason => { stopped.current = true; throw reason; })).find(item => item.taskId === task.taskId);
          if (!latest) { stopped.current = true; throw new Error(t("picker.taskMissing")); }
          task = latest;
        }
        if (task.status !== "succeeded") {
          if (task.status === "waitingForInput") stopped.current = true;
          update(target.id, { state: task.status === "cancelled" ? "skipped" : "failed", error: { message: task.message || t("picker.failed"), details: task.logs.slice(-12).join("\n") || undefined } });
        } else update(target.id, { state: "done" });
      } catch (reason) {
        update(target.id, { state: "failed", error: describeApiError(reason, t("picker.failed")) });
      } finally { activeTask.current = undefined; }
    }
    if (mounted.current) { setRunning(false); setFinished(true); onChanged?.(); }
  }
  async function stop() {
    stopped.current = true;
    if (activeTask.current) await api.cancelTask(activeTask.current).catch(() => undefined);
  }
  return <Dialog className="taskCenter batchRefDialog" aria-labelledby="batch-ref-title" onClose={onClose} busy={running} returnFocus={returnFocus}>
    <DialogHeader><h2 id="batch-ref-title">{t(`picker.${operation}`)} · {targets.length}</h2></DialogHeader>
    <div className="batchRefBody">
      <p className="cloneHelp">{t(operation === "pull" ? "picker.pullHelp" : operation === "push" ? "picker.pushHelp" : operation === "remove" ? "picker.removeHelp" : "picker.deleteHelp")}</p>
      <ul className="batchRefList" aria-label={t("picker.review")}>
        {targets.map(target => <li key={target.id}>
          <div><strong>{target.name}</strong>{target.detail && <small>{target.detail}</small>}</div>
          <span role="status">{results[target.id] ? t(`picker.${results[target.id].state}`) : target.blocked ? t("picker.skipped") : t("picker.ready")}</span>
          {target.blocked && <p>{target.blocked}</p>}
          {results[target.id]?.error && <p role="alert"><ErrorMessage error={results[target.id].error!} /></p>}
        </li>)}
      </ul>
    </div>
    <DialogFooter>
      {running ? <Button onClick={() => void stop()}>{t("picker.stop")}</Button> : <Button onClick={onClose}>{t(finished ? "common.close" : "common.cancel")}</Button>}
      {!finished && <Button variant={operation === "delete" || operation === "remove" ? "danger" : "primary"} disabled={running || targets.every(target => target.blocked)} onClick={() => void run()}>{t(running ? "picker.running" : "picker.confirm")}</Button>}
    </DialogFooter>
  </Dialog>;
}
