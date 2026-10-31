import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useCallback } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";
import { requireGitCrestBridge } from "../../../api/bridge";

/** Pipeline conflict tasks name their target like "uat · pipeline worktree" in targetPath. */
const PIPELINE_WORKTREE_SUFFIX = " · pipeline worktree";

interface OpenConflictWindowOptions {
  clearTaskError: () => void;
  setTaskError: (message: DisplayError) => void;
}

export function useOpenConflictWindow({ clearTaskError, setTaskError }: OpenConflictWindowOptions) {
  return useCallback(async (task: TaskSnapshotResponse) => {
    if (!task.repoId) return;
    try {
      await requireGitCrestBridge().openConflictWindow({ repoId: task.repoId, taskId: task.taskId, ...(task.targetPath?.endsWith(PIPELINE_WORKTREE_SUFFIX) ? { label: task.targetPath } : {}) });
      clearTaskError();
    } catch (error) {
      setTaskError(describeApiError(error, t("err.openConflict")));
    }
  }, [clearTaskError, setTaskError]);
}
