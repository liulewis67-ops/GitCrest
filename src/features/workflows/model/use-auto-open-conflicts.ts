import { useEffect, useRef } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";

interface AutoOpenConflictsOptions {
  tasks: TaskSnapshotResponse[];
  isRecoverableOperation: (operation: string) => boolean;
  openConflictWindow: (task: TaskSnapshotResponse) => void | Promise<boolean | void>;
}

/** Opens the conflict resolver once when a running merge-like task stops to wait for the user. */
export function useAutoOpenConflicts({ tasks, isRecoverableOperation, openConflictWindow }: AutoOpenConflictsOptions) {
  const opened = useRef(new Set<string>());
  useEffect(() => {
    for (const task of tasks) {
      if (task.status === "waitingForInput" && task.repoId && isRecoverableOperation(task.operation) && !opened.current.has(task.taskId)) {
        opened.current.add(task.taskId);
        void Promise.resolve(openConflictWindow(task)).then((success) => {
          if (success === false) opened.current.delete(task.taskId);
        }, () => opened.current.delete(task.taskId));
      }
    }
  }, [tasks, isRecoverableOperation, openConflictWindow]);
}
