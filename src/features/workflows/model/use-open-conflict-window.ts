import { PIPELINE_WORKTREE_SUFFIX, pipelineTargetLabel } from "../../../shared/lib/pipeline-target-label";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useCallback } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse } from "../../../api/client";
import { requireGitCrestBridge } from "../../../api/bridge";


interface OpenConflictWindowOptions {
  getApi: () => GitCrestApiClient | undefined;
  clearTaskError: () => void;
  setTaskError: (message: DisplayError) => void;
}

export function useOpenConflictWindow({ getApi, clearTaskError, setTaskError }: OpenConflictWindowOptions) {
  return useCallback(async (task: TaskSnapshotResponse, automatic = false) => {
    if (!task.repoId) return;
    try {
      if (automatic) {
        const api = getApi();
        if (!api) return false;
        const preview = await api.preflightRepositoryWorkflowRecovery(task.repoId, task.taskId);
        // Persisted waiting tasks may outlive the Git operation they belonged to.
        // A valid operation with all conflicts resolved still supports manual recovery.
        if (preview.conflictedPaths.length === 0 && preview.omittedConflictedPathCount === 0) return true;
      }
      await requireGitCrestBridge().openConflictWindow({ repoId: task.repoId, taskId: task.taskId, ...(task.targetPath?.endsWith(PIPELINE_WORKTREE_SUFFIX) ? { label: pipelineTargetLabel(task.targetPath) } : {}) });
      clearTaskError();
      return true;
    } catch (error) {
      if (automatic && error instanceof GitCrestApiError &&
        ["WORKFLOW_NO_ACTIVE_OPERATION", "TASK_NOT_FOUND"].includes(error.body.error.code)) return true;
      setTaskError(describeApiError(error, t("err.openConflict")));
      return false;
    }
  }, [getApi, clearTaskError, setTaskError]);
}
