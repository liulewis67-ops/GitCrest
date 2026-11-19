import { describeApiError, errorText } from "../../shared/i18n/api-errors";
import { useEffect } from "react";
import { getGitCrestBridge, requireGitCrestBridge } from "../../api/bridge";
import { useCoreConnection } from "../use-core-connection";
import { useGitIdentity } from "../../features/identity";
import { notify } from "../../shared/notices/notice-store";
import { getRepositoryDisplayName } from "../../shared/lib/repository-display-name";
import { getRepositoryEventRefreshPlan, useFolderDrop, useRepositoryMutations, useRepositoryOpening } from "../../features/repositories";
import { useStagingNotices } from "../../features/changes";
import { useOpenCreatedWorktree, useRemoteBranchDeleteSession } from "../../features/branches";
import { supportsWorkflowRecovery, useBackgroundTaskFeedback, useTaskCenter, useTaskNotifications } from "../../features/tasks";
import { useAutoOpenConflicts, useOpenConflictWindow, useWorkflowDialogSession, useWorkflowRecovery } from "../../features/workflows";
import { applyPipelineEvent } from "../../features/pipelines";
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
      void refreshTasks();
    },
    onEvent: (api, event, sequenceGap, isActive) => {
      applyPipelineEvent(event);
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
            const problem = describeApiError(syncError, t("app.refreshFailed"));
            setConnectionProblem(errorText(problem));
            setNotice(problem);
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

  useBackgroundTaskFeedback({ tasks, error: tasksError, openDetails: () => setTasksOpen(true) });

  const workflowDialog = useWorkflowDialogSession({
    appendTask: prependTask,
    setTaskError: setTasksError,
  });

  const remoteBranchDelete = useRemoteBranchDeleteSession({
    appendTask: prependTask,
    clearTaskError: () => setTasksError(""),
  });

  const recoverWorkflow = useWorkflowRecovery({
    getApi: () => apiRef.current,
    setActionId: setTaskActionId,
    setTaskError: setTasksError,
    refreshTasks,
  });

  const openConflictWindow = useOpenConflictWindow({ getApi: () => apiRef.current, clearTaskError: () => setTasksError(""), setTaskError: setTasksError });

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

  // Subscribe after core connection; preload takes queued requests so startup cannot drop a handoff.
  useEffect(() => { if (!ctx.tasksOpen) ctx.setTaskCenterTarget(undefined); }, [ctx.tasksOpen]);
  useEffect(() => {
    if (connectionState !== "connected") return;
    let active = true;
    const unsubscribe = getGitCrestBridge()?.subscribeToTaskCenterRequests?.((target) => {
      void apiRef.current?.listTasks().then((current) => {
        if (!active) return;
        const task = current.find((entry) => entry.taskId === target.taskId && entry.repoId === target.repoId);
        if (task) prependTask(task);
        const repository = repositories.find((entry) => entry.repoId === target.repoId);
        if (repository) fwd.activateRepository(repository);
        setSettingsView(undefined); setPage("workspace"); setTasksOpen(true);
        ctx.setTaskCenterTarget({ ...target, missing: !task });
      }).catch(() => { /* No acknowledgement: the conflict window keeps a retryable handoff. */ });
    });
    return () => { active = false; unsubscribe?.(); };
  }, [connectionState, repositories]);

  async function openRepositoryConflicts(repoId: string) {
    const api = apiRef.current;
    if (!api) return;
    try {
      const result = await api.adoptRepositoryWorkflow(repoId);
      let task = result.task;
      for (let attempt = 0; task && ["queued", "running"].includes(task.status) && attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        task = (await api.listTasks()).find((entry) => entry.taskId === task!.taskId) ?? null;
      }
      if (!task || task.status !== "waitingForInput") throw new Error(t("err.openConflict"));
      prependTask(task);
      await openConflictWindow(task);
    } catch (error) {
      const message = describeApiError(error, t("err.openConflict"));
      setTasksError(message);
      notify.warning(errorText(message));
    }
  }

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

  useAutoOpenConflicts({ tasks, isRecoverableOperation: supportsWorkflowRecovery, openConflictWindow: (task) => openConflictWindow(task, true) });
  return { toggleFavorite, forgetRepository, repositoryOpening, apiRef, status, connectionState, version, restartCore, gitIdentity, identityMissing, tasks, tasksError, setTasksError, taskActionId, refreshTasks, prependTask, appendTask, cancelTask, copyTaskLogs, workflowDialog, remoteBranchDelete, recoverWorkflow, openConflictWindow, openRepositoryConflicts, openExternally, openWebUrl, folderDragging };
}

export type Connection = ReturnType<typeof useAppConnection>;
