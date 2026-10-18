import { useEffect, useRef } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";

interface AutoOpenConflictsOptions {
  tasks: TaskSnapshotResponse[];
  isRecoverableOperation: (operation: string) => boolean;
  openConflictWindow: (task: TaskSnapshotResponse) => void;
}

/** Opens the conflict resolver once when a running merge-like task stops to wait for the user. */
export function useAutoOpenConflicts({ tasks, isRecoverableOperation, openConflictWindow }: AutoOpenConflictsOptions) {
  const seenStatus = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const previous = seenStatus.current;
    const next = new Map(tasks.map((task) => [task.taskId, task.status]));
    seenStatus.current = next;
    // The first snapshot only records state: tasks already waiting when the app starts are not re-opened.
    if (!previous) return;
    for (const task of tasks) {
      const before = previous.get(task.taskId);
      if (task.status === "waitingForInput" && task.repoId && isRecoverableOperation(task.operation) && (before === "queued" || before === "running" || before === undefined)) {
        openConflictWindow(task);
        break;
      }
    }
  }, [tasks, isRecoverableOperation, openConflictWindow]);
}
