import { useEffect } from "react";
import { getGitCrestBridge, requireGitCrestBridge } from "../../api/bridge";
import { useCoreConnection } from "../use-core-connection";
import { useGitIdentity } from "../../features/identity";
import { notify } from "../../shared/notices/notice-store";
import { getRepositoryDisplayName } from "../../shared/lib/repository-display-name";
import { getRepositoryEventRefreshPlan, useFolderDrop, useRepositoryMutations, useRepositoryOpening } from "../../features/repositories";
import { useStagingNotices } from "../../features/changes";
import { useOpenCreatedWorktree, useRemoteBranchDeleteSession } from "../../features/branches";
import { supportsWorkflowRecovery, useTaskCenter, useTaskNotifications } from "../../features/tasks";
import { useAutoOpenConflicts, useOpenConflictWindow, useWorkflowDialogSession, useWorkflowRecovery } from "../../features/workflows";
import type { Forward } from "./forward";
import type { Shell } from "./use-app-shell";

const TASK_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(["task.started", "task.completed", "task.failed"]);

export function useAppConnection(ctx: Shell, fwd: Forward) {
  const { historyRequests, isRepositoryTabOpen, repositories, selectedRepository, selectedRepositoryRef, setNotice, setOpenError, setPage, setRepositories, setSelectedRepository, setSettingsView, setTasksOpen, t } = ctx;

  const { toggleFavorite, forgetRepository } = useRepositoryMutations({
    getApi: () => apiRef.current,
    onRepositoriesChanged: (update) => setRepositories(update),
    onRepositoryForgotten: (repoId) => setSelectedRepository((current) => current?.repoId === repoId ? undefined : current),
    setError: setOpenError,
  });

  const repositoryOpening = useRepositoryOpening({
    getApi: () => apiRef.current,
    chooseRepository: () => requireGitCrestBridge().chooseRepository(),
    onRepositoryOpened: (repository, sortByRecentAccess) => {
      fwd.repositoryListRefresh.registerOpenedRepository(repository, sortByRecentAccess);
      fwd.activateRepository(repository);
    },
    refreshRepositories: (api) => fwd.refreshRepositories(api),
    setError: setOpenError,
  });

  const { apiRef, status, connectionState, version, setConnectionProblem, restartCore } = useCoreConnection({
    onConnected: async (api, reconnected) => {
      // A restarted core keeps the open tabs; only the first connection restores the saved workspace.
      await fwd.refreshRepositories(api, !reconnected);
      if (reconnected) void refreshTasks();
    },
    onEvent: (api, event, sequenceGap, isActive) => {
      // Read task state as soon as a task starts or ends. Waiting for the 1s poll left finished
      // tasks counted as running, which kept Commit and the remote actions blocked meanwhile.
      if (TASK_LIFECYCLE_EVENTS.has(event.type)) void refreshTasks();
      const plan = getRepositoryEventRefreshPlan(
        event,
        sequenceGap,
        selectedRepositoryRef.current?.repoId,
        isRepositoryTabOpen,
      );
      if (!plan) return;
      if (plan.refreshRepositories) {
        void fwd.refreshRepositories(api).then(() => {
          if (plan.reportRepositoryRefreshError && isActive()) setConnectionProblem(undefined);
        }, (syncError: unknown) => {
          if (plan.reportRepositoryRefreshError && isActive()) {
            setConnectionProblem(syncError instanceof Error ? syncError.message : t("app.refreshFailed"));
          }
        });
      }
      if (plan.repoId && plan.status) {
        void fwd.refreshRepositoryStatusScope(plan.repoId, plan.status.full, plan.status.paths);
      }
      if (plan.repoId && plan.refreshBranches) void fwd.refreshRepositoryBranches(plan.repoId);
      if (plan.repoId && plan.refreshRemotes) void fwd.refreshRepositoryRemotes(plan.repoId);
      if (plan.refreshHistory) historyRequests.refresh();
    },
  });

  const gitIdentity = useGitIdentity(apiRef.current, selectedRepository?.repoId, Boolean(selectedRepository));

  // Unknown while loading or after a failed read, so only a confirmed gap blocks committing.
  const identityMissing = gitIdentity.identity?.resolved === false;

  const {
    tasks,
    error: tasksError,
    setError: setTasksError,
    actionId: taskActionId,
    setActionId: setTaskActionId,
    refresh: refreshTasks,
    prependTask,
    appendTask,
    cancel: cancelTask,
    copyLogs: copyTaskLogs,
  } = useTaskCenter(() => apiRef.current);

  const workflowDialog = useWorkflowDialogSession({
    appendTask: prependTask,
    setTaskError: setTasksError,
    openTaskCenter: () => setTasksOpen(true),
  });

  const remoteBranchDelete = useRemoteBranchDeleteSession({
    appendTask: prependTask,
    clearTaskError: () => setTasksError(""),
    openTaskCenter: () => setTasksOpen(true),
  });

  const recoverWorkflow = useWorkflowRecovery({
    getApi: () => apiRef.current,
    setActionId: setTaskActionId,
    setTaskError: setTasksError,
    refreshTasks,
  });

  const openConflictWindow = useOpenConflictWindow({ clearTaskError: () => setTasksError(""), setTaskError: setTasksError });

  /** Starts an external program through the desktop app; a missing editor sends the user to Settings. */
  async function openExternally(kind: "editor" | "terminal", repoId: string, relativePath?: string) {
    const bridge = getGitCrestBridge();
    const open = kind === "editor" ? bridge?.openInEditor : bridge?.openInTerminal;
    if (!open) {
      notify.warning(t("tools.desktopOnly"));
      return;
    }
    try {
      const result = await open({ repoId, ...(relativePath ? { relativePath } : {}) });
      if (result.ok) return;
      setNotice(result.message);
      if (result.code === "noEditor" || result.code === "badEditor") setSettingsView({ section: "general" });
    } catch {
      setNotice(t("tools.openFailed"));
    }
  }

  function openWebUrl(url: string) {
    const bridge = getGitCrestBridge();
    if (!bridge?.openExternalUrl) {
      notify.warning(t("tools.desktopOnly"));
      return;
    }
    void bridge.openExternalUrl(url).then((opened) => { if (!opened) setNotice(t("tools.openFailed")); }, () => setNotice(t("tools.openFailed")));
  }

  useStagingNotices({
    tasks,
    repoId: selectedRepository?.repoId,
    announce: (message, undo) => { notify.success(message, { label: t("stn.undo"), run: undo }); },
    undo: () => { void fwd.undoRecentOperation(); },
  });

  useTaskNotifications({
    tasks,
    repositoryName: (repoId) => {
      const repository = repositories.find((entry) => entry.repoId === repoId);
      return repository ? getRepositoryDisplayName(repository.path) : undefined;
    },
    notify: getGitCrestBridge()?.showNotification ? (request) => { void getGitCrestBridge()?.showNotification?.(request); } : undefined,
  });

  // Clicking a notification shows the repository and the task list.
  useEffect(() => {
    return getGitCrestBridge()?.subscribeToNotificationClicks?.((target) => {
      const repository = target.repoId ? repositories.find((entry) => entry.repoId === target.repoId) : undefined;
      if (repository) {
        fwd.activateRepository(repository);
        setPage("workspace");
      }
      setTasksOpen(true);
    });
  }, [repositories]);

  const folderDragging = useFolderDrop({
    onFolder: (path) => { void repositoryOpening.openAtPath(path); },
    onProblem: (message) => { setOpenError(message); notify.warning(message); },
  });

  useOpenCreatedWorktree({ tasks, getApi: () => apiRef.current, openPath: (path) => repositoryOpening.openAtPath(path), onOpened: () => setTasksOpen(false) });

  useAutoOpenConflicts({ tasks, isRecoverableOperation: supportsWorkflowRecovery, openConflictWindow: (task) => void openConflictWindow(task) });
  return { toggleFavorite, forgetRepository, repositoryOpening, apiRef, status, connectionState, version, restartCore, gitIdentity, identityMissing, tasks, tasksError, setTasksError, taskActionId, refreshTasks, prependTask, appendTask, cancelTask, copyTaskLogs, workflowDialog, remoteBranchDelete, recoverWorkflow, openConflictWindow, openExternally, openWebUrl, folderDragging };
}

export type Connection = ReturnType<typeof useAppConnection>;
