import { useEffect, useRef } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";
import type { DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { pushNotice } from "../../../shared/notices/notice-store";
import { taskOutcome } from "./task-presentation";

/** Operations stay in the background; failures offer an explicit route to their details. */
export function useBackgroundTaskFeedback({ tasks, error, openDetails }: {
  tasks: TaskSnapshotResponse[];
  error: DisplayError;
  openDetails: () => void;
}) {
  const previousStatuses = useRef(new Map<string, string>());
  const openDetailsRef = useRef(openDetails);
  openDetailsRef.current = openDetails;

  useEffect(() => {
    if (error) pushNotice({
      key: "task-request-error", kind: "error", message: error,
      action: { label: t("state.openTasks"), run: () => openDetailsRef.current() },
    });
  }, [error]);

  useEffect(() => {
    const previous = previousStatuses.current;
    previousStatuses.current = new Map(tasks.map((task) => [task.taskId, task.status]));
    for (const task of tasks) {
      const before = previous.get(task.taskId);
      if (!before || !["queued", "running", "waitingForInput"].includes(before)
        || task.status !== "failed" || task.operation === "fetchBackground") continue;
      pushNotice({
        key: `task-failed:${task.taskId}`, kind: "error", message: taskOutcome(task),
        action: { label: t("state.openTasks"), run: () => openDetailsRef.current() },
      });
    }
  }, [tasks]);
}
