import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
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
  reportError: (message: DisplayError) => void;
  onTerminalPlan?: (task: TaskSnapshotResponse, plan: TaskRepositoryRefreshPlan) => void;
}

export function useTaskRefreshEffects(options: TaskRefreshEffectsOptions): void {
  const plannerRef = useRef(new TaskRefreshPlanner());
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const repositoryRefreshControllersRef = useRef(new Map<string, AbortController>());

  useEffect(() => () => {
    for (const controller of repositoryRefreshControllersRef.current.values()) controller.abort();
    repositoryRefreshControllersRef.current.clear();
  }, []);

  useEffect(() => {
    const current = optionsRef.current;
    for (const task of current.tasks) {
      if (task.repoId && plannerRef.current.shouldRefreshWorkflowInput(task)) {
        void current.refreshRepositoryStatus(task.repoId);
      }

      const plan = plannerRef.current.takeTerminalTaskPlan(task);
      if (!plan) continue;
      if (["branch", "remote", "pull", "workflow", "operation"].includes(plan.kind) && !plan.repoId) continue;

      const repoId = plan.repoId;
      // The core refreshes its stored repository record (HEAD, branch) as it reads branches, and a durable
      // operation does not refresh it when it finishes. Read branches first so the repository read below is current.
      const branchesRead = repoId && plan.refreshBranches ? current.refreshRepositoryBranches(repoId) : undefined;
      if (repoId && plan.refreshRepository) {
        const api = current.getApi();
        if (api) {
          const previousController = repositoryRefreshControllersRef.current.get(repoId);
          previousController?.abort();
          const controller = new AbortController();
          repositoryRefreshControllersRef.current.set(repoId, controller);
          const afterBranches = plan.kind === "operation" && branchesRead ? branchesRead.catch(() => undefined) : Promise.resolve();
          void afterBranches.then(() => api.withSignal(controller.signal).getRepository(repoId)).then((repository) => {
            if (!controller.signal.aborted && repositoryRefreshControllersRef.current.get(repoId) === controller) {
              optionsRef.current.updateRepository(repository);
            }
          }).catch((error: unknown) => {
            if (!controller.signal.aborted && plan.reportRepositoryRefreshError) {
              optionsRef.current.reportError(describeApiError(error, t("err.refreshMeta")));
            }
          }).finally(() => {
            if (repositoryRefreshControllersRef.current.get(repoId) === controller) {
              repositoryRefreshControllersRef.current.delete(repoId);
            }
          });
        }
      }
      if (plan.repoId && plan.refreshStatus) void current.refreshRepositoryStatus(plan.repoId);
      void branchesRead;
      if (plan.repoId && plan.refreshRemotes) void current.refreshRepositoryRemotes(plan.repoId);
      if (plan.refreshHistory) current.refreshHistory();
      current.onTerminalPlan?.(task, plan);
    }
  }, [options.tasks]);
}
