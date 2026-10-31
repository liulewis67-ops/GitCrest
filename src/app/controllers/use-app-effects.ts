import { useEffect } from "react";
import { reconcileWorkingSelection } from "../../features/changes";
import { useTaskRefreshEffects } from "../../features/tasks";
import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";
import type { DiffArea } from "./use-app-diff";
import type { Work } from "./use-app-work";

export function useAppEffects(ctx: Shell & Connection & Repositories & DiffArea & Work) {
  const { activeStatus, apiRef, clearCommittedDraft, commitSubmission, continueCommitPush, diffQuery, historyRequests, refreshRepositoryBranches, refreshRepositoryRemotes, refreshRepositoryStatus, reviewableFiles, selectedFilePath, selectedFileScope, selectedRepository, setCommitPanelTab, setFocusMode, setOverlayInspectorFor, setRepositories, setSelectedRepository, setTasksError, setTasksOpen, tasks, windowSizeClass, workspaceSessionActions } = ctx;

  useTaskRefreshEffects({
    tasks,
    getApi: () => apiRef.current,
    refreshRepositoryStatus,
    refreshRepositoryBranches,
    refreshRepositoryRemotes,
    refreshHistory: historyRequests.refresh,
    updateRepository: (repository) => {
      setRepositories((current) => current.map((entry) => entry.repoId === repository.repoId ? repository : entry));
      setSelectedRepository((current) => current?.repoId === repository.repoId ? repository : current);
    },
    reportError: setTasksError,
    onTerminalPlan: (task, plan) => {
      // Staging runs without opening the task center; a failure still has to be seen.
      if (plan.kind === "staging" && task.status === "failed") setTasksOpen(true);
      // Staged or discarded lines leave the open diff outdated; read it again in place.
      if (plan.kind === "staging" && task.status === "succeeded" && task.repoId === selectedRepository?.repoId) diffQuery.retry();
      if (plan.kind !== "commit") return;
      const commitContext = commitSubmission.takeTaskContext(task.taskId);
      // The commit may finish after the user switched tabs, so it clears its own repository's draft.
      if (task.status === "succeeded" && task.repoId && commitContext) {
        clearCommittedDraft(task.repoId, commitContext.message, commitContext.selections);
      }
      const intent = commitContext?.intent;
      if (task.status === "succeeded" && task.repoId && intent && intent.action !== "commit") {
        void continueCommitPush(task.repoId, intent);
      }
    },
  });

  useEffect(() => {
    if (selectedRepository?.availability === "available") {
      void refreshRepositoryStatus(selectedRepository.repoId);
      void refreshRepositoryBranches(selectedRepository.repoId);
      void refreshRepositoryRemotes(selectedRepository.repoId);
    }
  }, [selectedRepository?.repoId]);

  // Transient panel state belongs to one repository and one window size.
  useEffect(() => {
    setFocusMode(false);
    setOverlayInspectorFor(undefined);
    setCommitPanelTab("commit");
  }, [selectedRepository?.repoId]);

  useEffect(() => {
    setOverlayInspectorFor(undefined);
  }, [windowSizeClass]);

  // Keep the Changes selection on a file that still exists: follow it between staged and
  // unstaged, fall back to the first changed file, or clear it once the tree is clean.
  const reviewableKey = reviewableFiles.map((file) => `${file.scopes.join(",")}:${file.path}`).join("\n");

  useEffect(() => {
    const repoId = selectedRepository?.repoId;
    if (!repoId || !activeStatus || activeStatus.repoId !== repoId) return;
    const current = selectedFilePath && selectedFileScope ? { path: selectedFilePath, scope: selectedFileScope } : undefined;
    const next = reconcileWorkingSelection(reviewableFiles, current);
    if (next?.path === current?.path && next?.scope === current?.scope) return;
    workspaceSessionActions.selectWorkingFile(repoId, next);
  }, [reviewableKey, selectedRepository?.repoId, activeStatus?.repoId, selectedFilePath, selectedFileScope]);
}
