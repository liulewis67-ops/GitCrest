import type { RepositoryResponse, TaskSnapshotResponse } from "../../../api/client";
import { t } from "../../../shared/i18n";
import { taskOperationLabel, taskOutcome } from "./task-presentation";

export type TaskHistoryRange = "recent" | "all" | "custom";
export const TASK_DAY_MS = 86_400_000;

export function filterTaskHistory(tasks: TaskSnapshotResponse[], repositories: RepositoryResponse[], filters: {
  query: string; range: TaskHistoryRange; from: string; to: string; now: number; targetId?: string;
}) {
  const query = filters.query.trim().toLocaleLowerCase();
  const start = filters.from ? new Date(`${filters.from}T00:00:00`).getTime() : -Infinity;
  const end = filters.to ? new Date(`${filters.to}T00:00:00`) : undefined;
  // Local calendar days include the whole end date, including daylight-saving transitions.
  end?.setDate(end.getDate() + 1);
  return tasks.filter((task) => {
    if (task.taskId === filters.targetId && !query && filters.range === "recent") return true;
    const active = ["queued", "running", "waitingForInput"].includes(task.status);
    if (filters.range === "recent" && !active && task.updatedAtMs < filters.now - TASK_DAY_MS) return false;
    if (filters.range === "custom" && (task.updatedAtMs < start || task.updatedAtMs >= (end?.getTime() ?? Infinity))) return false;
    if (!query) return true;
    const repository = repositories.find((entry) => entry.repoId === task.repoId);
    return [task.taskId, task.operation, taskOperationLabel(task.operation), taskOutcome(task), t(`tk.status.${task.status}`),
      repository?.path, task.targetPath, task.message, ...task.logs].filter(Boolean).join("\n").toLocaleLowerCase().includes(query);
  });
}
