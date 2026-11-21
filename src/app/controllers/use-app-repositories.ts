import { compareBranchActivity } from "../../shared/lib/branch-order";
import { type GitCrestApiClient, type RepositoryResponse } from "../../api/client";
import type { DisplayError } from "../../shared/i18n/api-errors";
import { isRepositoryReadFailure } from "../../features/repositories";
import { useThemePreference } from "../../features/settings";
import { useWindowSizeClass } from "../../shared/hooks/use-window-size-class";
import { DEFAULT_WORKSPACE_MODE, usePanelPreferences, useRepositoryCacheLifecycle, useRepositoryListRefresh, useRepositoryTabLifecycle, useWorkspaceCommitAction, useWorkspaceCommitSelection, useWorkspaceGraphScroll, useWorkspaceLayout, useWorkspaceSessionActions } from "../../features/repositories";
import { useRepositoryStatus } from "../../features/changes";
import { useBranchSwitchShelfFlow, useBranchSwitcher, useRepositoryRefs } from "../../features/branches";
import { useAdoptInProgressWorkflow } from "../../features/workflows";
import type { Forward } from "./forward";
import { announceOperationsUnavailable } from "../../features/operations";
import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";

export function useAppRepositories(ctx: Shell & Connection, fwd: Forward) {
  const { historyReadErrors, setHistoryReadErrors, setTasksOpen, apiRef, connectionState, focusMode, historyBranch, isRepositoryTabOpen, overlayInspectorFor, page, prependTask, repositories, selectedRepository, setOpenError, setPage, setRepositories, setSelectedRepository, setTasksError, setWorkspaceSession, tasks, workspaceSession, workspaceSessionRef } = ctx;

  const repositoryCacheLifecycle = useRepositoryCacheLifecycle((repoId) =>
    workspaceSessionRef.current.openRepoIds.includes(repoId));

  const {
    snapshots: statusSnapshots,
    errors: statusErrors,
    loadingByRepo: statusLoadingByRepo,
    refreshScope: refreshRepositoryStatusScope,
    refresh: refreshRepositoryStatus,
    clear: clearRepositoryStatus,
  } = useRepositoryStatus({
    getApi: () => apiRef.current,
    isRepositoryOpen: isRepositoryTabOpen,
    getCacheGeneration: repositoryCacheLifecycle.getGeneration,
    beginCacheRequest: repositoryCacheLifecycle.beginRequest,
    finishCacheRequest: repositoryCacheLifecycle.finishRequest,
  });

  const {
    branches: branchSnapshots,
    branchErrors,
    branchLoadingByRepo,
    remotes: remoteSnapshots,
    remoteErrors,
    remoteLoadingByRepo,
    refreshBranches: refreshRepositoryBranches,
    refreshRemotes: refreshRepositoryRemotes,
    toggleFavorite: toggleBranchFavorite,
    setRemoteError,
    clear: clearRepositoryRefs,
  } = useRepositoryRefs({
    getApi: () => apiRef.current,
    isRepositoryOpen: isRepositoryTabOpen,
    getCacheGeneration: repositoryCacheLifecycle.getGeneration,
    beginCacheRequest: repositoryCacheLifecycle.beginRequest,
    finishCacheRequest: repositoryCacheLifecycle.finishRequest,
  });

  const branchSwitcher = useBranchSwitcher({
    getApi: () => apiRef.current,
    getRepository: () => selectedRepository,
    refreshBranches: refreshRepositoryBranches,
    onTaskAccepted: prependTask,
    onOperationStarted: () => setTasksOpen(true),
    onOperationUnavailable: announceOperationsUnavailable,
  });

  const branchSwitchShelfFlow = useBranchSwitchShelfFlow({
    tasks,
    getApi: () => apiRef.current,
    getSelectedRepositoryId: () => selectedRepository?.repoId,
    branchSwitcher,
    requestShelfComposer: (repoId) => fwd.requestShelfComposer(repoId),
    onBranchSwitchReview: branchSwitcher.reviewAfterShelf,
    appendTask: prependTask,
    setTaskError: setTasksError,
  });

  const mode = selectedRepository ? workspaceSession.tabs[selectedRepository.repoId]?.mode || DEFAULT_WORKSPACE_MODE : DEFAULT_WORKSPACE_MODE;

  const { preferences: panelPreferences, setSidebarHidden, setInspectorOpen } = usePanelPreferences();

  const windowSizeClass = useWindowSizeClass();

  // Below the wide breakpoint the inspector floats over the content instead of narrowing it.
  const inspectorOverlay = windowSizeClass !== "wide";

  const sidebarVisible = !focusMode && !panelPreferences.sidebarHidden[mode];

  const inspectorVisible = mode !== "changes" && !focusMode && (inspectorOverlay ? overlayInspectorFor === mode : panelPreferences.inspectorOpen[mode]);

  const rememberGraphScroll = useWorkspaceGraphScroll(selectedRepository?.repoId, mode, setWorkspaceSession);

  const { selectedCommit, selectCommit } = useWorkspaceCommitSelection(
    selectedRepository?.repoId,
    selectedRepository?.head,
    workspaceSession,
    setWorkspaceSession,
  );

  const workspaceSessionActions = useWorkspaceSessionActions(setWorkspaceSession);

  const repositoryTabLifecycle = useRepositoryTabLifecycle({
    sessionRef: workspaceSessionRef,
    setSession: setWorkspaceSession,
    activateSessionTab: workspaceSessionActions.activateRepository,
    closeSessionTab: workspaceSessionActions.closeTab,
    repositories,
    setSelectedRepository,
    clearOpenError: () => setOpenError(""),
    invalidateRepositoryUiCache,
    isWorkspacePage: () => page === "workspace",
    setPage,
  });

  const repositoryListRefresh = useRepositoryListRefresh({
    setRepositories,
    setSelectedRepository,
    sessionRef: workspaceSessionRef,
    setSession: setWorkspaceSession,
    restoreAvailableRepositories: workspaceSessionActions.restoreAvailableRepositories,
    setPage,
  });

  const rememberCommitAction = useWorkspaceCommitAction(selectedRepository?.repoId, setWorkspaceSession);

  const { theme, nextTheme } = useThemePreference();

  const { sidebarWidth, setSidebarWidth, historyGraphHeight, setHistoryGraphHeight, detailsWidth, setDetailsWidth, commitFilesWidth, setCommitFilesWidth } = useWorkspaceLayout(selectedRepository?.repoId);

  const connected = connectionState === "connected";

  useAdoptInProgressWorkflow({ getApi: () => apiRef.current, repoId: selectedRepository?.availability === "available" ? selectedRepository.repoId : undefined, connected, onAdopted: prependTask });

  const activeStatus = selectedRepository ? statusSnapshots[selectedRepository.repoId] : undefined;

  const activeStatusError = selectedRepository ? statusErrors[selectedRepository.repoId] : undefined;

  const activeStatusLoading = selectedRepository ? statusLoadingByRepo[selectedRepository.repoId] === true : false;

  const activeBranches = selectedRepository ? branchSnapshots[selectedRepository.repoId] : undefined;

  const hasBranchSnapshot = Boolean(activeBranches && Array.isArray(activeBranches.branches));

  const activeBranchError = selectedRepository ? branchErrors[selectedRepository.repoId] : undefined;

  const activeBranchesLoading = selectedRepository ? branchLoadingByRepo[selectedRepository.repoId] === true : false;

  const activeRemotes = selectedRepository ? remoteSnapshots[selectedRepository.repoId] : undefined;

  const activeRemoteError = selectedRepository ? remoteErrors[selectedRepository.repoId] : undefined;

  const activeRemotesLoading = selectedRepository ? remoteLoadingByRepo[selectedRepository.repoId] === true : false;

  const orderedBranches = hasBranchSnapshot ? [...activeBranches!.branches].sort(compareBranchActivity) : [];

  const repositoryReadErrors = repositories.reduce<Record<string, DisplayError>>((errors, repository) => {
    const failure = [statusErrors[repository.repoId], historyReadErrors[repository.repoId]].find(isRepositoryReadFailure);
    if (failure) errors[repository.repoId] = failure;
    return errors;
  }, {});
  const repositoryReadError = selectedRepository ? repositoryReadErrors[selectedRepository.repoId] : undefined;
  const repositoryReadable = Boolean(selectedRepository && selectedRepository.availability === "available" && !repositoryReadError);

  const activeTabState = selectedRepository ? workspaceSession.tabs[selectedRepository.repoId] : undefined;

  // A chosen branch that has since been deleted or renamed falls back to every branch's history.
  const shownHistoryBranch = historyBranch && historyBranch.repoId === selectedRepository?.repoId
    ? activeBranches?.branches.find((branch) => branch.fullName === historyBranch.fullName)
    : undefined;

  function invalidateRepositoryUiCache(repoId: string) {
    repositoryCacheLifecycle.invalidate(repoId);
    clearRepositoryStatus(repoId);
    clearRepositoryRefs(repoId);
    setHistoryReadErrors((current) => { const next = { ...current }; delete next[repoId]; return next; });
  }

  function activateRepository(repository: RepositoryResponse) {
    repositoryTabLifecycle.activate(repository);
  }

  async function refreshRepositories(api: GitCrestApiClient, restoreWorkspace = false) {
    await repositoryListRefresh.refresh(api, restoreWorkspace);
  }
  return { repositoryReadErrors, repositoryReadError, repositoryReadable, repositoryCacheLifecycle, refreshRepositoryStatusScope, refreshRepositoryStatus, remoteSnapshots, refreshRepositoryBranches, refreshRepositoryRemotes, toggleBranchFavorite, setRemoteError, branchSwitcher, branchSwitchShelfFlow, mode, panelPreferences, setSidebarHidden, setInspectorOpen, windowSizeClass, inspectorOverlay, sidebarVisible, inspectorVisible, rememberGraphScroll, selectedCommit, selectCommit, workspaceSessionActions, repositoryTabLifecycle, repositoryListRefresh, rememberCommitAction, theme, nextTheme, sidebarWidth, setSidebarWidth, historyGraphHeight, setHistoryGraphHeight, detailsWidth, setDetailsWidth, commitFilesWidth, setCommitFilesWidth, connected, activeStatus, activeStatusError, activeStatusLoading, activeBranches, hasBranchSnapshot, activeBranchError, activeBranchesLoading, activeRemotes, activeRemoteError, activeRemotesLoading, orderedBranches, activeTabState, shownHistoryBranch, activateRepository, refreshRepositories };
}

export type Repositories = ReturnType<typeof useAppRepositories>;
