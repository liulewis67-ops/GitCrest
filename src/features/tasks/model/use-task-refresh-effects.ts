import { useEffect, useRef } from "react";
import type { GitCrestApiClient, RepositoryResponse, TaskSnapshotResponse } from "../../../api/client";
import { TaskRefreshPlanner, type TaskRepositoryRefreshPlan } from "./task-refresh-planner";

interface TaskRefreshEffectsOptions {
  tasks: TaskSnapshotResponse[];
  getApi: () => GitCrestApiClient | undefined;
  refreshRepositoryStatus: (repoId: string) => Promise<void>;
  refreshRepositoryBranches: (repoId: string) => Promise<void>;
  refreshRepositoryRemotes: (repoId: string) => Promise<void>;
  refreshHistory: () => void;
  updateRepository: (repository: RepositoryResponse) => void;
  reportError: (message: string) => void;
  onTerminalPlan?: (task: TaskSnapshotResponse, plan: TaskRepositoryRefreshPlan) => void;
}

export function useTaskRefreshEffects(options: TaskRefreshEffectsOptions): void {
  const plannerRef = useRef(new TaskRefreshPlanner());
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const current = optionsRef.current;
    for (const task of current.tasks) {
      if (task.repoId && plannerRef.current.shouldRefreshWorkflowInput(task)) {
        void current.refreshRepositoryStatus(task.repoId);
      }

      const plan = plannerRef.current.takeTerminalTaskPlan(task);
      if (!plan) continue;
      if (["branch", "remote", "pull", "workflow"].includes(plan.kind) && !plan.repoId) continue;

      if (plan.repoId && plan.refreshRepository) {
        const api = current.getApi();
        if (api) {
          void api.getRepository(plan.repoId).then(current.updateRepository).catch((error: unknown) => {
            if (plan.reportRepositoryRefreshError) {
              current.reportError(error instanceof Error ? error.message : "Could not refresh repository metadata after commit.");
            }
          });
        }
      }
      if (plan.repoId && plan.refreshStatus) void current.refreshRepositoryStatus(plan.repoId);
      if (plan.repoId && plan.refreshBranches) void current.refreshRepositoryBranches(plan.repoId);
      if (plan.repoId && plan.refreshRemotes) void current.refreshRepositoryRemotes(plan.repoId);
      if (plan.refreshHistory) current.refreshHistory();
      current.onTerminalPlan?.(task, plan);
    }
  }, [options.tasks]);
}
