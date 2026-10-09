import { useCallback } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";
import { requireGitCrestBridge } from "../../../api/bridge";

interface OpenConflictWindowOptions {
  clearTaskError: () => void;
  setTaskError: (message: string) => void;
}

export function useOpenConflictWindow({ clearTaskError, setTaskError }: OpenConflictWindowOptions) {
  return useCallback(async (task: TaskSnapshotResponse) => {
    if (!task.repoId) return;
    try {
      await requireGitCrestBridge().openConflictWindow({ repoId: task.repoId, taskId: task.taskId });
      clearTaskError();
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "Could not open the conflict window.");
    }
  }, [clearTaskError, setTaskError]);
}
