import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useCallback } from "react";
import {
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";

type WorkflowRecoveryAction = "continue" | "skip" | "abort";

interface WorkflowRecoveryOptions {
  getApi: () => GitCrestApiClient | undefined;
  setActionId: (taskId: string) => void;
  setTaskError: (message: DisplayError) => void;
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
      if (!allowed || !current.headOid) throw new Error(t("err.recoveryStale"));
      await api.recoverRepositoryWorkflow(task.repoId, {
        taskId: task.taskId,
        action,
        expectedOperation: current.operation,
        expectedHeadOid: current.headOid,
        expectedConflictedPaths: current.conflictedPaths,
      });
      await refreshTasks();
    } catch (reason) {
      setTaskError(describeApiError(reason, t("err.queueRecovery")));
    } finally {
      setActionId("");
    }
  }, [getApi, refreshTasks, setActionId, setTaskError]);
}
