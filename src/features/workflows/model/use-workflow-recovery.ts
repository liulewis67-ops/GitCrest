import { useCallback } from "react";
import {
  GitCrestApiError,
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";

type WorkflowRecoveryAction = "continue" | "skip" | "abort";

interface WorkflowRecoveryOptions {
  getApi: () => GitCrestApiClient | undefined;
  setActionId: (taskId: string) => void;
  setTaskError: (message: string) => void;
  refreshTasks: () => Promise<void>;
}

export function useWorkflowRecovery({ getApi, setActionId, setTaskError, refreshTasks }: WorkflowRecoveryOptions) {
  return useCallback(async (task: TaskSnapshotResponse, action: WorkflowRecoveryAction) => {
    const api = getApi();
    if (!api || !task.repoId || task.status !== "waitingForInput") return;
    setActionId(task.taskId);
    setTaskError("");
    try {
      const current = await api.preflightRepositoryWorkflowRecovery(task.repoId, task.taskId);
      const allowed = action === "continue" ? current.canContinue : action === "skip" ? current.canSkip : current.canAbort;
      if (!allowed || !current.headOid) throw new Error("Repository state changed. Review the refreshed recovery preview before continuing.");
      await api.recoverRepositoryWorkflow(task.repoId, {
        taskId: task.taskId,
        action,
        expectedOperation: current.operation,
        expectedHeadOid: current.headOid,
        expectedConflictedPaths: current.conflictedPaths,
      });
      await refreshTasks();
    } catch (reason) {
      setTaskError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not queue workflow recovery.");
    } finally {
      setActionId("");
    }
  }, [getApi, refreshTasks, setActionId, setTaskError]);
}
