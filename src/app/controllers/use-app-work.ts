import { type TaskSnapshotResponse } from "../../api/client";
import { notify } from "../../shared/notices/notice-store";
import { useCommitSubmission } from "../../features/commits";
import { useCloneSubmission } from "../../features/cloning";
import { useStagingOperations } from "../../features/changes";
import { useTaskRefreshLifecycle } from "../../features/tasks";
import { inPlacePipelineState, usePipelineState } from "../../features/pipelines";
import { getRemoteActionDisabledReasons, useBackgroundFetch, useRemoteMutations, useRepositoryFetch, useRepositoryPull, useRepositoryPush } from "../../features/remotes";

import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import { announceOperationsUnavailable } from "../../features/operations";
import type { Repositories } from "./use-app-repositories";
import type { DiffArea } from "./use-app-diff";

export function useAppWork(ctx: Shell & Connection & Repositories & DiffArea) {
  const { repositoryReadable, activateRepository, activeCommitAction, activeRemotes, activeStatus, amendCommit, apiRef, appendTask, commitMessage, commitSelectionRepoId, commitSelections, commitSummary, connected, diffQuery, diffState, hasConflicts, historyRequests, identityMissing, isRepositoryTabOpen, page, prependTask, refreshRepositoryBranches, refreshRepositoryStatus, refreshTasks, repositories, repositoryCacheLifecycle, repositoryListRefresh, selectedRepository, setCommitSelections, setPushTargetDialogOpen, setRemoteError, setTasksError, setTasksOpen, signCommit, signOffCommit, stagedCount, t, tasks, tasksOpen } = ctx;

  const hasActiveTasks = tasks.some((task) => task.status === "queued" || task.status === "running");

  // A switch-in-place pipeline that is running owns the working tree, so it counts as a repository task.
  const pipelineOwnsTree = inPlacePipelineState(usePipelineState(), selectedRepository?.repoId) === "running";
  const hasActiveRepositoryTask = pipelineOwnsTree || tasks.some((task) => task.repoId === selectedRepository?.repoId && (task.status === "queued" || task.status === "running"));

  useBackgroundFetch({
    getApi: () => apiRef.current,
    repoId: selectedRepository?.repoId,
    ready: Boolean(
      page === "workspace" && selectedRepository && connected && selectedRepository.availability === "available"
      && !hasActiveRepositoryTask && !(activeRemotes && Array.isArray(activeRemotes.remotes) && activeRemotes.remotes.length === 0),
    ),
    tasks,
    onTaskAccepted: appendTask,
    onAuthenticationFailure: () => { notify.warning(t("bf.authFailed")); },
  });

  const { remoteDisabledReason, pushDisabledReason, pullDisabledReason } = getRemoteActionDisabledReasons({
    repository: selectedRepository,
    connected,
    hasActiveRepositoryTask,
  });

  const commitActionLabel = amendCommit
    ? activeCommitAction === "commit" ? t("app.amend") : activeCommitAction === "commitAndPushTo" ? t("app.amendAndPushTo") : t("app.amendAndPush")
    : activeCommitAction === "commit" ? t("app.commit") : activeCommitAction === "commitAndPushTo" ? t("app.commitAndPushTo") : activeCommitAction === "commitAndPushForce" ? t("app.commitAndPushForce") : t("app.commitAndPush");

  const commitActionIsDanger = activeCommitAction === "commitAndPushForce" || (amendCommit && activeCommitAction !== "commit");

  const hasActiveStagingTask = tasks.some((task) => (task.operation.startsWith("stage") || task.operation.startsWith("unstage")) && (task.status === "queued" || task.status === "running"));

  const commitSubmission = useCommitSubmission({
    getApi: () => apiRef.current,
    repoId: selectedRepository?.repoId,
    message: commitMessage,
    selections: commitSelections,
    amend: amendCommit,
    signOff: signOffCommit,
    sign: signCommit,
    setSelections: setCommitSelections,
    appendTask,
    setTaskError: setTasksError,
    openPushTargetPicker: () => setPushTargetDialogOpen(true),
    refreshRepositoryStatus: (repoId) => void refreshRepositoryStatus(repoId),
    retryDiff: diffQuery.retry,
  });

  const commitBusy = commitSubmission.busy;


  const {
    busy: stagingBusy,
    stageChanges,
    stageSelectedChanges,
    undoRecentOperation,
    discardSelection,
    hasActiveDiscardRepositoryTask,
    requestDiscard,
    clearDiscardSelection,
    discardSelectedChanges,
  } = useStagingOperations({
    getApi: () => apiRef.current,
    repository: selectedRepository,
    connected,
    hasActiveRepositoryTask,
    hasActiveRepositoryTaskForRepo: (repoId) => tasks.some((task) => task.repoId === repoId && (task.status === "queued" || task.status === "running")),
    hasActiveStagingTask,
    document: diffState.document,
    appendTask,
    prependTask,
    setTaskError: setTasksError,
  });

  const canCommit = Boolean(selectedRepository && activeStatus && stagedCount > 0 && !hasConflicts && commitSummary.trim() && !identityMissing && connected && !commitBusy && !stagingBusy && !hasActiveRepositoryTask && (!commitSelections.length || commitSelectionRepoId === selectedRepository.repoId));

  useTaskRefreshLifecycle({
    taskCenterOpen: tasksOpen,
    hasActiveTasks,
    activeRepositoryId: selectedRepository?.repoId,
    refreshTasks,
    refreshRepositoryStatus,
    refreshRepositoryBranches,
    refreshHistory: historyRequests.refresh,
  });

  const remoteMutations = useRemoteMutations({
    getApi: () => apiRef.current,
    repoId: selectedRepository?.repoId,
    isRepositoryOpen: isRepositoryTabOpen,
    getCacheGeneration: repositoryCacheLifecycle.getGeneration,
    beginCacheRequest: repositoryCacheLifecycle.beginRequest,
    finishCacheRequest: repositoryCacheLifecycle.finishRequest,
    setRemoteError,
    onTaskAccepted: (task) => {
      prependTask(task);
    },
  });

  const { fetchRepository, fetchAllRemotes } = useRepositoryFetch({
    getApi: () => apiRef.current,
    repoId: repositoryReadable ? selectedRepository?.repoId : undefined,
    onTaskAccepted: (task) => {
      appendTask(task);
      setTasksError("");
    },
    onError: (message) => {
      setTasksError(message);
    },
  });

  const cloneSubmission = useCloneSubmission({
    tasks,
    getApi: () => apiRef.current,
    onTaskAccepted: (task) => {
      appendTask(task);
      setTasksError("");
    },
    onRepositoryOpened: (repository) => {
      repositoryListRefresh.registerOpenedRepository(repository);
      activateRepository(repository);
    },
    closeTaskCenter: () => setTasksOpen(false),
    clearTaskError: () => setTasksError(""),
    setTaskError: setTasksError,
  });

  const {
    open: pullOpen,
    setOpen: setPullOpen,
    preflight: pullPreflight,
    loading: pullLoading,
    busy: pullBusy,
    error: pullError,
    refreshPreflight: refreshPullPreflight,
    openDialog: openPullDialog,
    submit: submitPull,
  } = useRepositoryPull({
    getApi: () => apiRef.current,
    repoId: repositoryReadable ? selectedRepository?.repoId : undefined,
    onSelectRepository: (repoId) => {
      if (repoId !== selectedRepository?.repoId) {
        const repository = repositories.find((entry) => entry.repoId === repoId);
        if (repository) activateRepository(repository);
      }
    },
    onTaskAccepted: (task) => {
      prependTask(task);
      setTasksError("");
    },
    onOperationStarted: () => setTasksOpen(true),
    onOperationUnavailable: announceOperationsUnavailable,
    refreshRepositoryStatus: (repoId) => void refreshRepositoryStatus(repoId),
  });

  const repositoryPush = useRepositoryPush({
    tasks,
    getApi: () => apiRef.current,
    repoId: repositoryReadable ? selectedRepository?.repoId : undefined,
    onSelectRepository: (repoId) => {
      if (repoId !== selectedRepository?.repoId) {
        const repository = repositories.find((entry) => entry.repoId === repoId);
        if (repository) activateRepository(repository);
      }
    },
    onTaskAccepted: (task, clearTaskError) => {
      prependTask(task);
      if (clearTaskError) setTasksError("");
    },
  });

  const {
    open: pushOpen,
    setOpen: setPushOpen,
    preflight: pushPreflight,
    loading: pushLoading,
    busy: pushBusy,
    error: pushError,
    forceOnly: pushForceOnly,
    refreshPreflight: refreshPushPreflight,
    openDialog: openPushDialog,
    submit: submitPush,
    continueCommitPush,
  } = repositoryPush;

  function fetchFromPushDialog() {
    setPushOpen(false);
    void fetchRepository();
  }

  function reviewTaskPush(task: TaskSnapshotResponse) {
    setTasksOpen(false);
    repositoryPush.reviewTask(task, selectedRepository?.repoId);
  }
  return { hasActiveRepositoryTask, remoteDisabledReason, pushDisabledReason, pullDisabledReason, commitActionLabel, commitActionIsDanger, hasActiveStagingTask, commitSubmission, commitBusy, canCommit, stagingBusy, stageChanges, stageSelectedChanges, undoRecentOperation, discardSelection, hasActiveDiscardRepositoryTask, requestDiscard, clearDiscardSelection, discardSelectedChanges, remoteMutations, fetchRepository, fetchAllRemotes, cloneSubmission, pullOpen, setPullOpen, pullPreflight, pullLoading, pullBusy, pullError, refreshPullPreflight, openPullDialog, submitPull, pushOpen, setPushOpen, pushPreflight, pushLoading, pushBusy, pushError, pushForceOnly, refreshPushPreflight, openPushDialog, submitPush, continueCommitPush, fetchFromPushDialog, reviewTaskPush };
}

export type Work = ReturnType<typeof useAppWork>;
