import { useI18n } from "../shared/i18n";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { type GitCrestApiClient, type RepositoryResponse, type TaskSnapshotResponse } from "../api/client";
import { getGitCrestBridge, requireGitCrestBridge } from "../api/bridge";
import { AppTitlebar, type AppPage } from "./layouts/AppTitlebar";
import { CommandPalette, type CommandPaletteCommand } from "./layouts/CommandPalette";
import { useCoreConnection } from "./use-core-connection";
import { WelcomePage } from "../pages/welcome/WelcomePage";
import { WorkspacePage } from "../pages/workspace/WorkspacePage";
import { CommitPanel, changeCode, type CommitPanelTab } from "../pages/workspace/CommitPanel";
import { BranchesSidebar } from "../pages/workspace/BranchesSidebar";
import { CommitInspector } from "../pages/workspace/CommitInspector";
import { WorkspaceDiffPanel } from "../pages/workspace/WorkspaceDiffPanel";
import { ViewLayout } from "../pages/workspace/ViewLayout";
import { HistorySplit } from "../pages/workspace/HistorySplit";
import { ariaShortcut, displayShortcut, loadSettingsPage, THEME_CYCLE, useShortcutPreferences, useThemePreference, useUpdateStatus, type SettingsSectionId } from "../features/settings";
import { useGlobalShortcuts } from "./use-global-shortcuts";
import { getRepositoryDisplayName } from "../shared/lib/repository-display-name";
import { useWindowSizeClass } from "../shared/hooks/use-window-size-class";
import { isComposerVisible, getSensitiveStagedPaths, loadCommitWorkbench, useCommitDraft, useCommitSubmission, type CommitAction } from "../features/commits";
import { loadCloneDialog, useCloneSubmission } from "../features/cloning";
import { httpsHostFromRemote } from "../shared/lib/https-remote-host";
import { DEFAULT_WORKSPACE_MODE, COMMIT_FILES_WIDTH, DETAILS_WIDTH, HISTORY_GRAPH_HEIGHT, SIDEBAR_WIDTH, getRepositoryEventRefreshPlan, usePanelPreferences, useRepositoryCacheLifecycle, useRepositoryListRefresh, useRepositoryMutations, useRepositoryOpening, useRepositoryTabLifecycle, useWorkspaceCommitAction, useWorkspaceCommitSelection, useWorkspaceGraphScroll, useWorkspaceLayout, useWorkspaceSessionActions, useWorkspaceSessionState, type WorkspaceMode } from "../features/repositories";
import { buildChangeTree, listReviewableFiles, reconcileWorkingSelection, summarizeRepositoryStatus, useRepositoryStatus, useStagingOperations } from "../features/changes";
import { CommitActionsMenu, isFullGitObjectId, loadCommitChanges, loadCommitGraph, useHistoryViewRequests, type CommitFileNavigation, type CommitWorkflowAction } from "../features/history";
import { hasCodeStructureSupport, loadDiscardChangesDialog, useDiffViewPreferences, useRepositoryDiffQuery } from "../features/diff";
import { useLanguageRegistry } from "../features/languages";
import { loadBranchSwitcherDialog, loadLocalBranchDialog, loadCreateBranchDialog, loadNewWorktreeDialog, loadRemoveWorktreeDialog, useOpenCreatedWorktree, WorktreeSwitcher, type LocalBranchAction, loadRemoteBranchDeleteDialog, useBranchSwitchShelfFlow, useBranchSwitcher, useRemoteBranchDeleteSession, useRepositoryRefs } from "../features/branches";
import { loadTaskCenter, supportsWorkflowRecovery, useTaskCenter, useTaskRefreshEffects, useTaskRefreshLifecycle } from "../features/tasks";
import { getRemoteActionDisabledReasons, loadPullDialog, loadPushDialog, loadPushTargetDialog, useRemoteMutations, useRepositoryFetch, useRepositoryPull, useRepositoryPush, type PushTarget } from "../features/remotes";
import { loadRebaseDialog, loadResetDialog, loadWorkflowDialog, useAdoptInProgressWorkflow, useAutoOpenConflicts, useOpenConflictWindow, useWorkflowDialogSession, useWorkflowRecovery } from "../features/workflows";

const TaskCenter = lazy(() => loadTaskCenter().then(({ TaskCenter }) => ({ default: TaskCenter })));
const WorkflowDialog = lazy(() => loadWorkflowDialog().then(({ WorkflowDialog }) => ({ default: WorkflowDialog })));
const RebaseDialog = lazy(() => loadRebaseDialog().then(({ RebaseDialog }) => ({ default: RebaseDialog })));
const ResetDialog = lazy(() => loadResetDialog().then(({ ResetDialog }) => ({ default: ResetDialog })));
const RemoteBranchDeleteDialog = lazy(() => loadRemoteBranchDeleteDialog().then(({ RemoteBranchDeleteDialog }) => ({ default: RemoteBranchDeleteDialog })));
const CreateBranchDialog = lazy(() => loadCreateBranchDialog().then(({ CreateBranchDialog }) => ({ default: CreateBranchDialog })));
const NewWorktreeDialog = lazy(() => loadNewWorktreeDialog().then(({ NewWorktreeDialog }) => ({ default: NewWorktreeDialog })));
const RemoveWorktreeDialog = lazy(() => loadRemoveWorktreeDialog().then(({ RemoveWorktreeDialog }) => ({ default: RemoveWorktreeDialog })));
const LocalBranchDialog = lazy(() => loadLocalBranchDialog().then(({ LocalBranchDialog }) => ({ default: LocalBranchDialog })));
const BranchSwitcherDialog = lazy(() => loadBranchSwitcherDialog().then(({ BranchSwitcherDialog }) => ({ default: BranchSwitcherDialog })));
const CloneDialog = lazy(() => loadCloneDialog().then(({ CloneDialog }) => ({ default: CloneDialog })));
const CommitGraph = lazy(loadCommitGraph);
const CommitChanges = lazy(loadCommitChanges);
const PushDialog = lazy(() => loadPushDialog().then(({ PushDialog }) => ({ default: PushDialog })));
const PullDialog = lazy(() => loadPullDialog().then(({ PullDialog }) => ({ default: PullDialog })));
const PushTargetDialog = lazy(() => loadPushTargetDialog().then(({ PushTargetDialog }) => ({ default: PushTargetDialog })));
const DiscardChangesDialog = lazy(() => loadDiscardChangesDialog().then(({ DiscardChangesDialog }) => ({ default: DiscardChangesDialog })));
const SettingsPage = lazy(() => loadSettingsPage().then(({ SettingsPage }) => ({ default: SettingsPage })));
const CommitWorkbench = lazy(() => loadCommitWorkbench().then(({ CommitWorkbench }) => ({ default: CommitWorkbench })));

const TASK_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set(["task.started", "task.completed", "task.failed"]);

function App() {
  const { t } = useI18n();
  const isMacPlatform = navigator.platform.toLowerCase().includes("mac");
  const commandKey = isMacPlatform ? "⌘" : "Ctrl";
  const [repositories, setRepositories] = useState<RepositoryResponse[]>([]);
  const [selectedRepository, setSelectedRepository] = useState<RepositoryResponse>();
  const [pushTargetDialogOpen, setPushTargetDialogOpen] = useState(false);
  const historyRequests = useHistoryViewRequests();
  const [shelfComposerRequest, setShelfComposerRequest] = useState<{ id: number; repoId?: string; preselect?: { paths: string[]; scope: "workingTree" | "index" } }>({ id: 0 });
  const [tasksOpen, setTasksOpen] = useState(false);
  const [localBranchAction, setLocalBranchAction] = useState<LocalBranchAction>();
  const [createBranchAt, setCreateBranchAt] = useState<string>();
  /** The branch chosen in the Branches view, whose history its commit graph shows. */
  const [historyBranch, setHistoryBranch] = useState<{ repoId: string; fullName: string }>();
  const [worktreeForBranch, setWorktreeForBranch] = useState<{ name: string; fromRemote: boolean }>();
  const [worktreeFrom, setWorktreeFrom] = useState<{ oid: string; label: string }>();
  const [removeWorktreePath, setRemoveWorktreePath] = useState<string>();
  // Settings covers the content area while open; the page underneath stays mounted.
  const [settingsView, setSettingsView] = useState<{ section?: SettingsSectionId; credentialHosts?: string[]; reopenClone?: boolean }>();
  const { updateStatus, checkForUpdates, installUpdate } = useUpdateStatus();
  const { shortcuts, setShortcuts } = useShortcutPreferences();
  const {
    message: commitMessage,
    setMessage: setCommitMessage,
    summary: commitSummary,
    setSummary: setCommitSummary,
    description: commitDescription,
    setDescription: setCommitDescription,
    template: commitTemplate,
    amend: amendCommit,
    setAmend: setAmendCommit,
    signOff: signOffCommit,
    setSignOff: setSignOffCommit,
    sign: signCommit,
    setSign: setSignCommit,
    selections: commitSelections,
    setSelections: setCommitSelections,
    selectionRepoId: commitSelectionRepoId,
    addDiffSelection: addCommitDiffSelection,
    chooseTemplate: chooseCommitTemplate,
    clearCommitted: clearCommittedDraft,
  } = useCommitDraft(selectedRepository?.repoId);
  const [commitAssistantOpen, setCommitAssistantOpen] = useState(false);
  const [commitActionMenuOpen, setCommitActionMenuOpen] = useState(false);
  const [openError, setOpenError] = useState("");
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
      repositoryListRefresh.registerOpenedRepository(repository, sortByRecentAccess);
      activateRepository(repository);
    },
    refreshRepositories,
    setError: setOpenError,
  });
  const { apiRef, status, connectionState, version, setConnectionProblem, restartCore } = useCoreConnection({
    onConnected: async (api, reconnected) => {
      // A restarted core keeps the open tabs; only the first connection restores the saved workspace.
      await refreshRepositories(api, !reconnected);
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
        void refreshRepositories(api).then(() => {
          if (plan.reportRepositoryRefreshError && isActive()) setConnectionProblem(undefined);
        }, (syncError: unknown) => {
          if (plan.reportRepositoryRefreshError && isActive()) {
            setConnectionProblem(syncError instanceof Error ? syncError.message : t("app.refreshFailed"));
          }
        });
      }
      if (plan.repoId && plan.status) {
        void refreshRepositoryStatusScope(plan.repoId, plan.status.full, plan.status.paths);
      }
      if (plan.repoId && plan.refreshBranches) void refreshRepositoryBranches(plan.repoId);
      if (plan.repoId && plan.refreshRemotes) void refreshRepositoryRemotes(plan.repoId);
      if (plan.refreshHistory) historyRequests.refresh();
    },
  });
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
  useOpenCreatedWorktree({ tasks, getApi: () => apiRef.current, openPath: (path) => repositoryOpening.openAtPath(path), onOpened: () => setTasksOpen(false) });
  useAutoOpenConflicts({ tasks, isRecoverableOperation: supportsWorkflowRecovery, openConflictWindow: (task) => void openConflictWindow(task) });
  const [page, setPage] = useState<AppPage>("welcome");
  const { session: workspaceSession, setSession: setWorkspaceSession, sessionRef: workspaceSessionRef } = useWorkspaceSessionState();
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
    openTaskCenter: () => setTasksOpen(true),
  });
  const branchSwitchShelfFlow = useBranchSwitchShelfFlow({
    tasks,
    getApi: () => apiRef.current,
    getSelectedRepositoryId: () => selectedRepository?.repoId,
    branchSwitcher,
    requestShelfComposer: (repoId) => requestShelfComposer(repoId),
    onBranchSwitchReview: branchSwitcher.reviewAfterShelf,
    appendTask: prependTask,
    setTaskError: setTasksError,
    openTaskCenter: () => setTasksOpen(true),
  });
  const mode = selectedRepository ? workspaceSession.tabs[selectedRepository.repoId]?.mode || DEFAULT_WORKSPACE_MODE : DEFAULT_WORKSPACE_MODE;
  const { preferences: panelPreferences, setSidebarHidden, setInspectorOpen } = usePanelPreferences();
  const windowSizeClass = useWindowSizeClass();
  // Below the wide breakpoint the inspector floats over the content instead of narrowing it.
  const inspectorOverlay = windowSizeClass !== "wide";
  // A floating inspector is opened per view and per visit; it never reopens by itself.
  const [overlayInspectorFor, setOverlayInspectorFor] = useState<WorkspaceMode>();
  const [focusMode, setFocusMode] = useState(false);
  const [commitPanelTab, setCommitPanelTab] = useState<CommitPanelTab>("commit");
  const [notice, setNotice] = useState("");
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
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
  const orderedBranches = hasBranchSnapshot ? [...activeBranches!.branches].sort((left, right) =>
    Number(right.isFavorite) - Number(left.isFavorite)
    || Number(right.isCurrent) - Number(left.isCurrent)
    || Number(left.kind === "remote") - Number(right.kind === "remote")
    || left.name.localeCompare(right.name)) : [];
  const activeTabState = selectedRepository ? workspaceSession.tabs[selectedRepository.repoId] : undefined;
  // A chosen branch that has since been deleted or renamed falls back to every branch's history.
  const shownHistoryBranch = historyBranch && historyBranch.repoId === selectedRepository?.repoId
    ? activeBranches?.branches.find((branch) => branch.fullName === historyBranch.fullName)
    : undefined;

  function isRepositoryTabOpen(repoId: string): boolean {
    return workspaceSessionRef.current.openRepoIds.includes(repoId);
  }

  function invalidateRepositoryUiCache(repoId: string) {
    repositoryCacheLifecycle.invalidate(repoId);
    clearRepositoryStatus(repoId);
    clearRepositoryRefs(repoId);
  }

  const activeCommitAction: CommitAction = activeTabState?.commitAction || "commit";
  const selectedFilePath = activeTabState?.selectedFilePath;
  const selectedFileScope = activeTabState?.selectedFileScope;
  const historyFilePath = activeTabState?.selectedCommitFilePath;
  const historyFileOid = activeTabState?.selectedDiffCommitOid;
  const selectedDiffFile = (activeStatus?.files || []).find((file) => file.path === selectedFilePath);
  const { preferences: diffViewPreferences, updatePreferences: updateDiffViewPreferences } = useDiffViewPreferences();
  const { stagedCount, hasConflicts, conflictCount, workingCount } = summarizeRepositoryStatus(activeStatus);
  const changeTree = buildChangeTree(activeStatus);
  const reviewableFiles = listReviewableFiles(changeTree);
  // Each view reads its own file: Changes a working-tree or staged file, History a file of the selected commit.
  const diffTarget = mode === "changes" && selectedFilePath && selectedFileScope
    ? { path: selectedFilePath, scope: selectedFileScope, commitOid: undefined }
    : mode === "history" && historyFilePath && isFullGitObjectId(historyFileOid) && historyFileOid === selectedCommit
      ? { path: historyFilePath, scope: "commit" as const, commitOid: historyFileOid }
      : undefined;
  // The open file's status entry: when it changes (say from untracked to modified), its diff is read again.
  const diffStatusKey = diffTarget?.scope !== "commit" && selectedDiffFile
    ? [selectedDiffFile.kind, selectedDiffFile.indexStatus, selectedDiffFile.worktreeStatus, selectedDiffFile.categories.join(","), selectedDiffFile.originalPath ?? ""].join("|")
    : "";
  const diffQuery = useRepositoryDiffQuery({
    api: apiRef.current,
    enabled: Boolean(diffTarget),
    repository: selectedRepository,
    path: diffTarget?.path,
    scope: diffTarget?.scope,
    commitOid: diffTarget?.commitOid,
    context: diffViewPreferences.layout === "full" ? "full" : "hunks",
    refreshKey: diffStatusKey,
  });
  const { state: diffState, activeKey: activeDiffKey } = diffQuery;
  // The line view groups changes by code structure, which needs the complete file read after the same hunks.
  // Language plugins arrive after startup, so the registry is read here to re-render when they do.
  useLanguageRegistry();
  const hunksDocument = diffState.key === activeDiffKey && !diffState.loading ? diffState.document : undefined;
  const structureQuery = useRepositoryDiffQuery({
    api: apiRef.current,
    enabled: Boolean(diffTarget && hunksDocument?.status === "text" && diffViewPreferences.layout === "hunks" && hasCodeStructureSupport(diffTarget.path)),
    repository: selectedRepository,
    path: diffTarget?.path,
    scope: diffTarget?.scope,
    commitOid: diffTarget?.commitOid,
    context: "full",
    refreshKey: hunksDocument?.revision,
  });
  const sensitiveStagedPaths = getSensitiveStagedPaths(activeStatus);
  const hasActiveTasks = tasks.some((task) => task.status === "queued" || task.status === "running");
  const hasActiveRepositoryTask = tasks.some((task) => task.repoId === selectedRepository?.repoId && (task.status === "queued" || task.status === "running"));
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
    openTaskCenter: () => setTasksOpen(true),
    openPushTargetPicker: () => setPushTargetDialogOpen(true),
    refreshRepositoryStatus: (repoId) => void refreshRepositoryStatus(repoId),
    retryDiff: diffQuery.retry,
  });
  const commitBusy = commitSubmission.busy;
  const canCommit = Boolean(selectedRepository && activeStatus && stagedCount > 0 && !hasConflicts && commitSummary.trim() && connected && !commitBusy && !hasActiveRepositoryTask && (!commitSelections.length || commitSelectionRepoId === selectedRepository.repoId));
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
    openTaskCenter: () => setTasksOpen(true),
  });
  const selectedRepositoryRef = useRef(selectedRepository);
  selectedRepositoryRef.current = selectedRepository;
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
      setTasksOpen(true);
    },
  });
  const { fetchRepository } = useRepositoryFetch({
    getApi: () => apiRef.current,
    repoId: selectedRepository?.repoId,
    onTaskAccepted: (task) => {
      appendTask(task);
      setTasksError("");
      setTasksOpen(true);
    },
    onError: (message) => {
      setTasksError(message);
      setTasksOpen(true);
    },
  });
  const cloneSubmission = useCloneSubmission({
    tasks,
    getApi: () => apiRef.current,
    onTaskAccepted: (task) => {
      appendTask(task);
      setTasksOpen(true);
      setTasksError("");
    },
    onRepositoryOpened: (repository) => {
      repositoryListRefresh.registerOpenedRepository(repository);
      activateRepository(repository);
    },
    closeTaskCenter: () => setTasksOpen(false),
    clearTaskError: () => setTasksError(""),
    setTaskError: setTasksError,
    openTaskCenter: () => setTasksOpen(true),
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
    repoId: selectedRepository?.repoId,
    onSelectRepository: (repoId) => {
      if (repoId !== selectedRepository?.repoId) {
        const repository = repositories.find((entry) => entry.repoId === repoId);
        if (repository) activateRepository(repository);
      }
    },
    onTaskAccepted: (task) => {
      prependTask(task);
      setTasksError("");
      setTasksOpen(true);
    },
    refreshRepositoryStatus: (repoId) => void refreshRepositoryStatus(repoId),
  });
  const repositoryPush = useRepositoryPush({
    tasks,
    getApi: () => apiRef.current,
    repoId: selectedRepository?.repoId,
    onSelectRepository: (repoId) => {
      if (repoId !== selectedRepository?.repoId) {
        const repository = repositories.find((entry) => entry.repoId === repoId);
        if (repository) activateRepository(repository);
      }
    },
    onTaskAccepted: (task, clearTaskError) => {
      prependTask(task);
      if (clearTaskError) setTasksError("");
      setTasksOpen(true);
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

  function runCommitAction(action: CommitAction) {
    if (action === "commitAndPushTo") {
      setPushTargetDialogOpen(true);
      return;
    }
    void commitChanges(action);
  }

  function chooseCommitAction(action: CommitAction) {
    rememberCommitAction(action);
    setCommitActionMenuOpen(false);
    runCommitAction(action);
  }

  function commitChanges(action: CommitAction = activeCommitAction, target?: PushTarget) {
    void commitSubmission.submit(action, canCommit, target);
  }

  function addDiffSelectionToCommit(selections: Array<{ hunkIndex: number; rowIndex?: number; side?: "old" | "new" }>) {
    const document = diffState.document;
    if (!selectedRepository || !document || document.scope !== "index") return;
    addCommitDiffSelection(document.path, document.revision, selections);
  }

  function openAccountSettings(credentialHosts: string[] = [], reopenClone = false) {
    setSettingsView({ section: "accounts", credentialHosts, reopenClone });
  }

  function closeSettings() {
    const reopenClone = settingsView?.reopenClone;
    setSettingsView(undefined);
    if (reopenClone) cloneSubmission.openDialog();
  }

  function configureTaskCredentials(task: TaskSnapshotResponse) {
    const remotes = task.repoId ? remoteSnapshots[task.repoId]?.remotes ?? [] : [];
    const hosts = remotes.flatMap((remote) => remote.fetchUrls.map(httpsHostFromRemote).filter((host): host is string => Boolean(host)));
    setTasksOpen(false);
    openAccountSettings([...new Set(hosts)]);
  }

  function activateRepository(repository: RepositoryResponse) {
    repositoryTabLifecycle.activate(repository);
  }

  function changeWorkspaceMode(nextMode: WorkspaceMode) {
    if (!selectedRepository) {
      setPage("workspace");
      return;
    }
    workspaceSessionActions.changeMode(selectedRepository.repoId, nextMode);
  }

  function toggleSidebar() {
    if (!selectedRepository) return;
    if (focusMode) {
      setFocusMode(false);
      setSidebarHidden(mode, false);
      return;
    }
    setSidebarHidden(mode, !panelPreferences.sidebarHidden[mode]);
  }

  function openInspector() {
    setFocusMode(false);
    if (inspectorOverlay) setOverlayInspectorFor("history");
    else setInspectorOpen("history", true);
  }

  function closeInspector() {
    if (inspectorOverlay) setOverlayInspectorFor(undefined);
    else setInspectorOpen(mode, false);
    requestAnimationFrame(() => document.getElementById("inspector-toggle")?.focus());
  }

  function toggleInspector() {
    if (!selectedRepository || mode === "changes") return;
    if (inspectorVisible) closeInspector();
    else openInspector();
  }

  function toggleFocusMode() {
    if (!selectedRepository) return;
    setFocusMode((current) => !current);
  }

  /** Esc outside dialogs: leave focus mode first, then close a floating inspector. */
  function dismissTransientPanels() {
    if (focusMode) setFocusMode(false);
    else if (inspectorOverlay && overlayInspectorFor === mode && mode !== "changes") closeInspector();
  }

  function requestShelfComposer(repoId: string, preselect?: { paths: string[]; scope: "workingTree" | "index" }) {
    changeWorkspaceMode("changes");
    setFocusMode(false);
    setSidebarHidden("changes", false);
    setCommitPanelTab("shelves");
    setShelfComposerRequest((request) => ({ id: request.id + 1, repoId, preselect }));
  }

  function showFileHistory(path: string) {
    if (!selectedRepository) return;
    historyRequests.showFileHistory(selectedRepository.repoId, path);
    changeWorkspaceMode("history");
  }

  /** Rollback from the file tree: the whole unstaged diff goes to the same confirmation as a hunk discard. */
  async function rollbackFile(path: string) {
    const api = apiRef.current;
    if (!api || !selectedRepository) return;
    try {
      const document = await api.getFileDiff(selectedRepository.repoId, path, "workingTree");
      if (document.status !== "text" || document.hunks.length === 0) {
        setNotice(t("ctx.rollbackNoText", { path }));
        return;
      }
      requestDiscard(document, document.hunks.map((_, hunkIndex) => ({ hunkIndex })));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("ctx.rollbackNoText", { path }));
    }
  }

  function revealFile(absolutePath: string) {
    void getGitCrestBridge()?.showItemInFolder?.(absolutePath).catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : String(error));
    });
  }

  function focusCommitMessage(attempt = 0) {
    const input = document.getElementById("commit-message");
    if (input) input.focus();
    else if (attempt < 30) requestAnimationFrame(() => focusCommitMessage(attempt + 1));
  }

  function showCommitComposer() {
    changeWorkspaceMode("changes");
    setFocusMode(false);
    setSidebarHidden("changes", false);
    setCommitPanelTab("commit");
    focusCommitMessage();
  }

  function openTagEditor(oid: string) {
    if (!selectedRepository || !isFullGitObjectId(oid)) return;
    if (mode === "changes") changeWorkspaceMode("history");
    openInspector();
    historyRequests.openTagEditor(selectedRepository.repoId, oid);
  }

  async function copyCommitSha(oid: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(oid);
      setNotice(t("hv.copied", { oid: oid.slice(0, 7) }));
    } catch {
      setNotice(t("hv.copyFailed"));
    }
  }

  async function copyBranchName(name: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(name);
      setNotice(t("bs.copiedName", { name }));
    } catch {
      setNotice(t("bs.copyNameFailed"));
    }
  }

  function openFileDiff(path: string, scope: "workingTree" | "index") {
    const repoId = selectedRepository?.repoId;
    if (!repoId) return;
    workspaceSessionActions.openFileDiff(repoId, path, scope);
  }

  function openCommitFileDiff(path: string, oid: string) {
    const repoId = selectedRepository?.repoId;
    if (!repoId || !isFullGitObjectId(oid)) return;
    workspaceSessionActions.openCommitFileDiff(repoId, path, oid);
  }

  async function openDiffWindow(path: string, scope: "workingTree" | "index" | "commit", commitOid?: string) {
    const repoId = selectedRepository?.repoId;
    if (!repoId) return;
    try {
      await requireGitCrestBridge().openDiffWindow({ repoId, path, scope, ...(commitOid ? { commitOid } : {}) });
    } catch (error) {
      diffQuery.setWindowError(error);
    }
  }

  function closeRepositoryTab(repoId: string) {
    repositoryTabLifecycle.close(repoId);
  }

  async function refreshRepositories(api: GitCrestApiClient, restoreWorkspace = false) {
    await repositoryListRefresh.refresh(api, restoreWorkspace);
  }

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

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

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

  useGlobalShortcuts({
    page,
    shortcuts,
    isMacPlatform,
    connected,
    repository: selectedRepository ? { repoId: selectedRepository.repoId, availability: selectedRepository.availability } : undefined,
    selectedCommit,
    repositoryHeadIsFull: isFullGitObjectId(selectedRepository?.head),
    hasActiveStatus: Boolean(activeStatus),
    workingCount,
    hasConflicts,
    stagingBusy,
    hasActiveStagingTask,
    hasActiveRepositoryTask,
    activeStatusLoading,
    hasSelectedFile: Boolean(selectedFilePath),
    stagedCount,
    commitBusy,
    hasActiveBranches: Boolean(activeBranches),
  }, {
    openRepository: () => { void repositoryOpening.chooseAndOpenLocal(); },
    cloneRepository: () => cloneSubmission.openDialog(),
    initializeRepository: () => { void repositoryOpening.chooseAndInitializeLocal(); },
    stageAll: () => { void stageChanges("stageAll"); },
    undoRecentOperation: () => { void undoRecentOperation(); },
    fetch: () => { void fetchRepository(); },
    push: openPushDialog,
    refreshStatus: (repoId) => { void refreshRepositoryStatus(repoId, true); },
    openDiff: () => changeWorkspaceMode("changes"),
    searchCommits: (repoId) => {
      if (mode === "changes") changeWorkspaceMode("history");
      // The search box sits above the commit graph, which focus mode hides.
      setFocusMode(false);
      historyRequests.focusSearch(repoId);
    },
    openShelfComposer: () => {
      if (selectedRepository) requestShelfComposer(selectedRepository.repoId);
    },
    cherryPick: (repoId, targetOid) => workflowDialog.open(repoId, targetOid, "cherryPick"),
    createTag: (_repoId, oid) => openTagEditor(oid),
    openSettings: () => setSettingsView({}),
    // Committing belongs to Changes; elsewhere the shortcut would commit a draft the user cannot see.
    commit: () => { if (mode === "changes") void commitChanges("commit"); },
    commitAndPush: () => { if (mode === "changes") void commitChanges("commitAndPush"); },
    pull: openPullDialog,
    rebase: workflowDialog.openRebase,
    openBranchSwitcher: branchSwitcher.openSwitcher,
    toggleCommandPalette: () => {
      setPaletteOpen((open) => !open);
      setPaletteQuery("");
    },
    openCommitAssistant: () => {
      changeWorkspaceMode("changes");
      setFocusMode(false);
      setSidebarHidden("changes", false);
      setCommitPanelTab("commit");
      setCommitAssistantOpen(true);
    },
    closeCommandPalette: () => setPaletteOpen(false),
    showView: changeWorkspaceMode,
    toggleSidebar,
    toggleInspector,
    toggleFocusMode,
    dismissTransientPanels,
  });


  const commands: CommandPaletteCommand[] = [
    { id: "welcome", label: t("cmd.welcome"), detail: t("cmd.welcomeDetail"), available: true, run: () => setPage("welcome") },
    { id: "workspace", label: t("cmd.workspace"), detail: t("cmd.workspaceDetail"), available: true, run: () => setPage("workspace") },
    { id: "appearance", label: t("cmd.appearance"), detail: t("cmd.appearanceDetail"), available: true, run: () => setSettingsView({ section: "appearance" }) },
    { id: "theme", label: t("cmd.theme"), detail: t("cmd.themeDetail", { current: t(`theme.${theme}`), next: t(`theme.${THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]}`) }), available: true, run: nextTheme },
    { id: "open", label: t("cmd.open"), detail: t("cmd.openDetail"), available: true, run: () => { void repositoryOpening.chooseAndOpenLocal(); } },
    { id: "branch-switcher", label: t("cmd.branchSwitcher"), detail: t("cmd.branchSwitcherDetail", { shortcut: displayShortcut(shortcuts.branchSwitcher, isMacPlatform) }), available: Boolean(selectedRepository && connected && selectedRepository.availability === "available"), run: branchSwitcher.openSwitcher },
    { id: "branch-here", label: t("cmd.branchHere"), detail: t("cmd.branchHereDetail"), available: Boolean(selectedRepository && connected && selectedRepository.availability === "available" && !hasActiveRepositoryTask && isFullGitObjectId(selectedCommit)), run: () => { if (isFullGitObjectId(selectedCommit)) setCreateBranchAt(selectedCommit); } },
    { id: "fetch", label: t("cmd.fetch"), detail: t("cmd.fetchDetail"), available: Boolean(selectedRepository), run: () => { void fetchRepository(); } },
    { id: "pull", label: t("cmd.pull"), detail: t("cmd.pullDetail"), available: Boolean(selectedRepository), run: () => openPullDialog() },
    { id: "rebase", label: t("cmd.rebase"), detail: t("cmd.rebaseDetail", { shortcut: displayShortcut(shortcuts.rebase, isMacPlatform) }), available: Boolean(selectedRepository && activeBranches && connected), run: workflowDialog.openRebase },
    { id: "reset", label: t("cmd.reset"), detail: t("cmd.resetDetail"), available: Boolean(selectedRepository && activeBranches && connected), run: () => workflowDialog.openReset() },
    { id: "push", label: t("cmd.push"), detail: t("cmd.pushDetail"), available: Boolean(selectedRepository), run: () => openPushDialog() },
    { id: "ai-commit-message", label: t("cmd.ai"), detail: t("cmd.aiDetail", { shortcut: displayShortcut(shortcuts.aiCommitMessage, isMacPlatform) }), available: Boolean(selectedRepository && stagedCount > 0 && !hasConflicts && !commitBusy), run: () => setCommitAssistantOpen(true) },
    { id: "clone", label: t("cmd.clone"), detail: t("cmd.cloneDetail"), available: connected, run: () => cloneSubmission.openDialog() },
    { id: "view-changes", label: t("cmd.viewChanges"), detail: t("cmd.viewChangesDetail", { shortcut: displayShortcut(shortcuts.viewChanges, isMacPlatform) }), available: Boolean(selectedRepository), run: () => changeWorkspaceMode("changes") },
    { id: "view-history", label: t("cmd.viewHistory"), detail: t("cmd.viewHistoryDetail", { shortcut: displayShortcut(shortcuts.viewHistory, isMacPlatform) }), available: Boolean(selectedRepository), run: () => changeWorkspaceMode("history") },
    { id: "toggle-sidebar", label: t("cmd.toggleSidebar"), detail: t("cmd.toggleSidebarDetail", { shortcut: displayShortcut(shortcuts.toggleSidebar, isMacPlatform) }), available: Boolean(selectedRepository && page === "workspace"), run: toggleSidebar },
    { id: "toggle-details", label: t("cmd.toggleDetails"), detail: t("cmd.toggleDetailsDetail", { shortcut: displayShortcut(shortcuts.toggleInspector, isMacPlatform) }), available: Boolean(selectedRepository && page === "workspace" && mode !== "changes"), run: toggleInspector },
    { id: "focus-mode", label: t("cmd.focus"), detail: t("cmd.focusDetail", { shortcut: displayShortcut(shortcuts.focusMode, isMacPlatform) }), available: Boolean(selectedRepository && page === "workspace" && diffTarget), run: toggleFocusMode },
    { id: "manage-remotes", label: t("cmd.manageRemotes"), detail: t("cmd.manageRemotesDetail"), available: Boolean(selectedRepository), run: () => { changeWorkspaceMode("history"); setSidebarHidden("history", false); setFocusMode(false); } },
  ];
  const composerVisible = isComposerVisible({
    inChangesView: mode === "changes" && !focusMode,
    statusReady: Boolean(activeStatus),
    stagedCount,
    workingCount,
    draft: `${commitSummary}${commitDescription}`,
    amend: amendCommit,
  });
  const currentBranch = activeBranches?.branches?.find((branch) => branch.kind === "local" && branch.isCurrent);
  const workflowDisabledReason = !connected
    ? t("details.connectFirst")
    : selectedRepository?.availability !== "available"
      ? t("details.repoUnavailable")
      : hasActiveRepositoryTask ? t("details.waitTask") : undefined;
  const inspectorSize = { width: detailsWidth, min: DETAILS_WIDTH.min, max: DETAILS_WIDTH.max, label: t("app.resizeDetails"), onResize: setDetailsWidth };
  const changesIndex = reviewableFiles.findIndex((file) => file.path === selectedFilePath);
  const selectedReviewable = changesIndex >= 0 ? reviewableFiles[changesIndex] : undefined;

  function openReviewableFile(index: number) {
    const file = reviewableFiles[index];
    if (file) openFileDiff(file.path, file.scopes[0]);
  }

  function renderDiffPanel(target: NonNullable<typeof diffTarget>, extra: { status?: { code: string; kind: string }; fileMissing?: boolean; scopes?: Array<"workingTree" | "index">; fileNavigation?: CommitFileNavigation }) {
    return <WorkspaceDiffPanel
      scopeOptions={extra.scopes && extra.scopes.length > 1 && target.scope !== "commit" ? { available: extra.scopes, onChange: (scope) => openFileDiff(target.path, scope) } : undefined}
      path={target.path}
      scope={target.scope}
      commitOid={target.commitOid}
      status={extra.status}
      activeDiffKey={activeDiffKey}
      diffState={diffState}
      fileMissing={extra.fileMissing}
      selectionDisabled={stagingBusy || hasActiveStagingTask || commitBusy}
      fileNavigation={extra.fileNavigation}
      focusMode={focusMode}
      shortcuts={shortcuts}
      isMacPlatform={isMacPlatform}
      diffViewPreferences={diffViewPreferences}
      onChangeDiffViewPreferences={updateDiffViewPreferences}
      onToggleFocusMode={toggleFocusMode}
      onRetryDiff={diffQuery.retry}
      structureSource={{ state: structureQuery.state, activeKey: structureQuery.activeKey, retry: structureQuery.retry }}
      onStageSelection={stageSelectedChanges}
      onDiscardSelection={requestDiscard}
      onCommitSelection={addDiffSelectionToCommit}
      onOpenDiffWindow={(path, scope, oid) => void openDiffWindow(path, scope, oid)}
    />;
  }

  function renderCommitGraph() {
    if (!selectedRepository || !apiRef.current) return null;
    if (!isFullGitObjectId(selectedRepository.head)) {
      return <div className="viewEmpty"><h2>{selectedRepository.head ? t("main.connectingHistory") : t("hv.noCommits")}</h2><p>{t("hv.noCommitsHint")}</p></div>;
    }
    return <Suspense fallback={<div className="graphViewport" role="status" aria-live="polite">{t("main.loadingHistory")}</div>}>
      <CommitGraph
        key={`${selectedRepository.repoId}:${mode}`}
        api={apiRef.current}
        repoId={selectedRepository.repoId}
        selectedOid={selectedCommit}
        initialScrollTop={workspaceSession.tabs[selectedRepository.repoId]?.graphScrollTop || 0}
        refreshKey={historyRequests.refreshKey}
        focusSearchRequest={historyRequests.searchFocusRequest}
        searchShortcut={ariaShortcut(shortcuts.searchCommits, isMacPlatform)}
        onFocusSearchHandled={historyRequests.markSearchFocusHandled}
        pathFilterRequest={historyRequests.pathFilterRequest}
        onPathFilterHandled={historyRequests.markPathFilterHandled}
        branchScope={shownHistoryBranch?.name}
        onClearBranchScope={() => setHistoryBranch(undefined)}
        onScrollPosition={rememberGraphScroll}
        onSelect={selectCommit}
      />
    </Suspense>;
  }

  function renderCommitActions(oid: string) {
    return <CommitActionsMenu
      oid={oid}
      workflowDisabledReason={workflowDisabledReason}
      onWorkflow={(action: CommitWorkflowAction, target) => { if (selectedRepository) workflowDialog.open(selectedRepository.repoId, target, action); }}
      onCreateBranch={setCreateBranchAt}
      onCreateTag={openTagEditor}
      onCopySha={(target) => void copyCommitSha(target)}
      onCheckout={(target) => branchSwitcher.checkoutCommit(target)}
      onReset={(target) => workflowDialog.openReset(target)}
      resetDisabledReason={activeBranches?.branches.find((branch) => branch.isCurrent)?.oid === oid ? t("hv.resetIsHead") : undefined}
    />;
  }

  function renderInspector() {
    if (!selectedRepository) return null;
    // The changes under the graph already list the commit's files and actions.
    return <CommitInspector
      repository={selectedRepository}
      selectedCommit={selectedCommit}
      api={apiRef.current}
      overlay={inspectorOverlay}
      showFiles={false}
      selectedFilePath={historyFileOid === selectedCommit ? historyFilePath : undefined}
      openTagRequest={historyRequests.tagEditorRequest}
      shortcuts={shortcuts}
      isMacPlatform={isMacPlatform}
      onClose={closeInspector}
      onOpenFile={openCommitFileDiff}
      onOpenDiffWindow={(path, oid) => void openDiffWindow(path, "commit", oid)}
      onTagRequestHandled={historyRequests.markTagEditorHandled}
      onUseMessage={setCommitMessage}
      draftHasText={Boolean(commitMessage.trim())}
    />;
  }

  const paletteContext = page === "welcome"
    ? t("app.ctxWelcome")
    : selectedRepository
      ? t("app.ctxWorkspace", { name: getRepositoryDisplayName(selectedRepository.path).toUpperCase() })
      : t("app.ctxNoRepo");

  return (
    <main className="appShell">
      <AppTitlebar
        page={page}
        openRepoIds={workspaceSession.openRepoIds}
        repositories={repositories}
        selectedRepository={selectedRepository}
        shortcuts={shortcuts}
        status={status}
        connected={connected}
        connecting={connectionState === "connecting"}
        onRestartCore={() => void restartCore()}
        activeTaskCount={tasks.filter((task) => task.status === "queued" || task.status === "running").length}
        isMacPlatform={isMacPlatform}
        openingRepository={repositoryOpening.opening}
        onPageChange={(nextPage) => { setSettingsView(undefined); setPage(nextPage); }}
        onSelectRepository={(repository) => { setSettingsView(undefined); void repositoryOpening.openRecent(repository); }}
        onCloseRepository={closeRepositoryTab}
        onOpenLocalRepository={() => void repositoryOpening.chooseAndOpenLocal()}
        onCloneRepository={() => cloneSubmission.openDialog()}
        onInitializeRepository={() => void repositoryOpening.chooseAndInitializeLocal()}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onOpenTasks={() => setTasksOpen(true)}
        onOpenSettings={() => setSettingsView((open) => open ? undefined : {})}
      />

      {page === "welcome" ? (
        <WelcomePage
          repositories={repositories}
          openingRepository={repositoryOpening.opening}
          connected={connected}
          shortcuts={shortcuts}
          isMacPlatform={isMacPlatform}
          openError={openError}
          version={version}
          onOpenLocalRepository={() => void repositoryOpening.chooseAndOpenLocal()}
          onCloneRepository={() => cloneSubmission.openDialog()}
          onNavigateWorkspace={() => setPage("workspace")}
          onInitializeRepository={() => void repositoryOpening.chooseAndInitializeLocal()}
          onOpenRepository={(repository) => void repositoryOpening.openRecent(repository)}
          onToggleFavorite={(repository) => void toggleFavorite(repository)}
          onForgetRepository={(repository) => void forgetRepository(repository)}
        />
      ) : (
        <WorkspacePage
          repository={selectedRepository}
          mode={mode}
          changedFileCount={activeStatus ? reviewableFiles.length : undefined}
          conflictCount={conflictCount}
          currentBranch={currentBranch}
          remoteCount={activeRemotes && Array.isArray(activeRemotes.remotes) ? activeRemotes.remotes.length : undefined}
          shortcuts={shortcuts}
          isMacPlatform={isMacPlatform}
          connected={connected}
          hasActiveRepositoryTask={hasActiveRepositoryTask}
          pushDisabledReason={pushDisabledReason}
          pullDisabledReason={pullDisabledReason}
          sidebarVisible={sidebarVisible}
          inspectorAvailable={mode !== "changes"}
          inspectorOpen={inspectorVisible}
          focusMode={focusMode}
          openingRepository={repositoryOpening.opening}
          worktreeSwitcher={selectedRepository && apiRef.current ? <WorktreeSwitcher
            api={apiRef.current}
            repoId={selectedRepository.repoId}
            refreshKey={historyRequests.refreshKey}
            disabled={!connected || repositoryOpening.opening}
            onOpen={(path) => void repositoryOpening.openAtPath(path)}
          /> : undefined}
          onChangeMode={changeWorkspaceMode}
          onOpenPushDialog={openPushDialog}
          onOpenPullDialog={openPullDialog}
          onFetchRepository={() => void fetchRepository()}
          onOpenBranchSwitcher={branchSwitcher.openSwitcher}
          onToggleSidebar={toggleSidebar}
          onToggleInspector={toggleInspector}
          onOpenTasks={() => setTasksOpen(true)}
          returnBranch={(selectedRepository ? branchSwitcher.returnBranches[selectedRepository.repoId] : undefined)}
          onReturnToBranch={(name) => { branchSwitcher.openSwitcher(); void branchSwitcher.inspect(name); }}
          onCreateBranchAtHead={() => { if (isFullGitObjectId(selectedRepository?.head)) setCreateBranchAt(selectedRepository.head); }}
          onOpenRepository={() => void repositoryOpening.chooseAndOpenLocal()}
        >
          {selectedRepository && mode === "changes" && <ViewLayout
            className="changesLayout"
            sidebar={sidebarVisible ? <CommitPanel
              repository={selectedRepository}
              api={apiRef.current}
              status={activeStatus}
              statusError={activeStatusError}
              statusLoading={activeStatusLoading}
              tree={changeTree}
              workingCount={workingCount}
              stagedCount={stagedCount}
              hasConflicts={hasConflicts}
              stagingBusy={stagingBusy}
              hasActiveStagingTask={hasActiveStagingTask}
              selectedFilePath={selectedFilePath}
              selectedFileScope={selectedFileScope}
              connected={connected}
              hasActiveRepositoryTask={hasActiveRepositoryTask}
              shortcuts={shortcuts}
              isMacPlatform={isMacPlatform}
              tab={commitPanelTab}
              historyRefreshKey={historyRequests.refreshKey}
              shelfComposerRequest={shelfComposerRequest.repoId === selectedRepository.repoId ? shelfComposerRequest.id : 0}
              shelfComposerPreselect={shelfComposerRequest.repoId === selectedRepository.repoId ? shelfComposerRequest.preselect : undefined}
              shelfComposerAfterSwitch={branchSwitchShelfFlow.shelfComposerAfterSwitch?.repoId === selectedRepository.repoId ? branchSwitchShelfFlow.shelfComposerAfterSwitch : undefined}
              composer={composerVisible ? <Suspense fallback={null}>
                <CommitWorkbench
                  repository={selectedRepository}
                  status={{ snapshot: activeStatus, stagedCount, hasConflicts, sensitiveStagedPaths }}
                  commit={{ message: commitMessage, summary: commitSummary, description: commitDescription, template: commitTemplate, selections: commitSelections, selectionRepoId: commitSelectionRepoId, activeAction: activeCommitAction, actionLabel: commitActionLabel, actionIsDanger: commitActionIsDanger, actionMenuOpen: commitActionMenuOpen, assistantOpen: commitAssistantOpen, amend: amendCommit, signOff: signOffCommit, sign: signCommit, busy: commitBusy, canCommit }}
                  shortcuts={shortcuts}
                  isMacPlatform={isMacPlatform}
                  connected={connected}
                  hasActiveRepositoryTask={hasActiveRepositoryTask}
                  api={apiRef.current}
                  onChangeMessage={setCommitMessage}
                  onChangeSummary={setCommitSummary}
                  onChangeDescription={setCommitDescription}
                  onChangeTemplate={chooseCommitTemplate}
                  onClearSelections={() => setCommitSelections([])}
                  onAssistantOpenChange={setCommitAssistantOpen}
                  onSelectAmend={setAmendCommit}
                  onSelectSignOff={setSignOffCommit}
                  onSelectSign={setSignCommit}
                  onSubmit={runCommitAction}
                  onChooseAction={chooseCommitAction}
                  onToggleActionMenu={() => setCommitActionMenuOpen((open) => !open)}
                />
              </Suspense> : undefined}
              onTabChange={setCommitPanelTab}
              onStageChanges={(action, target) => void stageChanges(action, target)}
              onRefreshStatus={(repoId, force) => void refreshRepositoryStatus(repoId, force)}
              onOpenFileDiff={openFileDiff}
              onOpenDiffWindow={(path, scope) => void openDiffWindow(path, scope)}
              onShelveFiles={(paths, scope) => requestShelfComposer(selectedRepository.repoId, { paths, scope })}
              onRollbackFile={(path) => void rollbackFile(path)}
              onShowFileHistory={showFileHistory}
              onRevealFile={revealFile}
              onShelve={() => requestShelfComposer(selectedRepository.repoId)}
              onShelfTaskSubmitted={(task, switchTarget) => {
                void refreshRepositoryStatus(selectedRepository.repoId);
                if (task) prependTask(task);
                branchSwitchShelfFlow.onShelfComposerTaskSubmitted(task, switchTarget);
                void refreshTasks();
              }}
              onShelfComposerClosed={branchSwitchShelfFlow.onShelfComposerClosed}
              onShelfComposerRequestHandled={() => setShelfComposerRequest((request) => ({ id: request.id }))}
            /> : undefined}
            sidebarSize={{ width: sidebarWidth, min: SIDEBAR_WIDTH.min, max: SIDEBAR_WIDTH.max, label: t("app.resizeNav"), onResize: setSidebarWidth }}
            inspectorSize={inspectorSize}
            inspectorOverlay={false}
          >
            {!activeStatus ? activeStatusError
              ? <div className="viewEmpty" role="alert"><p>{activeStatusError}</p><button className="secondaryButton" type="button" onClick={() => void refreshRepositoryStatus(selectedRepository.repoId, true)}>{t("nav.retry")}</button></div>
              : <div className="viewEmpty" role="status"><span className="loadingSpinner" aria-hidden="true" /><p>{t("nav.loadingStatus")}</p></div>
              : reviewableFiles.length === 0 ? <div className="viewEmpty cleanState" role="status">
                <span className="viewEmptyGlyph" aria-hidden="true">✓</span>
                <h2>{t("chg.cleanTitle")}</h2>
                <p>{t("chg.cleanBody")}</p>
                <button className="secondaryButton" type="button" onClick={() => changeWorkspaceMode("history")}>{t("chg.browseHistory")}</button>
              </div>
                : diffTarget ? renderDiffPanel(diffTarget, {
                  status: selectedReviewable ? { code: changeCode(selectedReviewable.kind), kind: selectedReviewable.kind } : undefined,
                  fileMissing: !selectedDiffFile,
                  scopes: selectedReviewable?.scopes,
                  fileNavigation: changesIndex >= 0 ? { index: changesIndex, total: reviewableFiles.length, onPrevious: () => openReviewableFile(changesIndex - 1), onNext: () => openReviewableFile(changesIndex + 1) } : undefined,
                })
                  : <div className="viewEmpty"><h2>{t("chg.selectFile")}</h2><p>{t("chg.selectFileHint")}</p></div>}
          </ViewLayout>}

          {selectedRepository && mode === "history" && <ViewLayout
            className="historyLayout"
            sidebar={sidebarVisible ? <BranchesSidebar
              repository={selectedRepository}
              api={apiRef.current}
              branches={activeBranches}
              orderedBranches={orderedBranches}
              branchError={activeBranchError}
              branchesLoading={activeBranchesLoading}
              remotes={activeRemotes}
              remoteError={activeRemoteError}
              remotesLoading={activeRemotesLoading}
              remoteActionBusy={remoteMutations.busy}
              remoteDisabledReason={remoteDisabledReason}
              connected={connected}
              hasActiveRepositoryTask={hasActiveRepositoryTask}
              historyRefreshKey={historyRequests.refreshKey}
              shortcuts={shortcuts}
              isMacPlatform={isMacPlatform}
              selectedBranch={shownHistoryBranch?.fullName}
              onSelectBranch={(branch) => {
                setHistoryBranch({ repoId: selectedRepository.repoId, fullName: branch.fullName });
                if (isFullGitObjectId(branch.oid)) selectCommit(branch.oid);
              }}
              onManageAccounts={(hosts) => openAccountSettings(hosts)}
              onRefreshBranches={(repoId) => void refreshRepositoryBranches(repoId)}
              onOpenBranchSwitcher={branchSwitcher.openSwitcher}
              onDeleteRemoteBranch={remoteBranchDelete.open}
              onSwitchBranch={(name) => { branchSwitcher.openSwitcher(); void branchSwitcher.inspect(name); }}
              onCheckoutRemoteBranch={(name) => { branchSwitcher.openSwitcher(); void branchSwitcher.inspect(name, true); }}
              onMergeBranch={(oid, name) => workflowDialog.open(selectedRepository.repoId, oid, "merge", name)}
              onRebaseOnto={workflowDialog.openRebaseOnto}
              onCreateBranchFrom={setCreateBranchAt}
              onCopyBranchName={(name) => void copyBranchName(name)}
              onOpenWorktree={(path) => void repositoryOpening.openAtPath(path)}
              onNewWorktreeForBranch={(name, fromRemote) => setWorktreeForBranch({ name, fromRemote })}
              onNewWorktreeFrom={(oid, label) => setWorktreeFrom({ oid, label })}
              onRemoveWorktree={setRemoveWorktreePath}
              onRevealPath={revealFile}
              onWorktreePruneStarted={(task) => { prependTask(task); setTasksError(""); setTasksOpen(true); }}
              onManageBranch={(name, branchMode) => setLocalBranchAction({ name, mode: branchMode })}
              onToggleBranchFavorite={(fullName, favorite) => void toggleBranchFavorite(selectedRepository.repoId, fullName, favorite)}
              onRefreshRemotes={(repoId) => void refreshRepositoryRemotes(repoId)}
              onAddRemote={remoteMutations.addRepositoryRemote}
              onSetRemoteUrl={remoteMutations.setRepositoryRemoteUrl}
              onDeleteRemote={remoteMutations.deleteRepositoryRemote}
              onSetDefaultRemote={remoteMutations.setRepositoryDefaultRemote}
              onSetBranchUpstream={remoteMutations.setRepositoryBranchUpstream}
            /> : undefined}
            sidebarSize={{ width: sidebarWidth, min: SIDEBAR_WIDTH.min, max: SIDEBAR_WIDTH.max, label: t("app.resizeNav"), onResize: setSidebarWidth }}
            inspector={inspectorVisible ? renderInspector() : undefined}
            inspectorSize={inspectorSize}
            inspectorOverlay={inspectorOverlay}
          >
            {/* Without a resolved HEAD the graph's own empty state says why; there is no commit to show changes for. */}
            {isFullGitObjectId(selectedRepository.head) ? <HistorySplit
              graph={focusMode ? undefined : <section className="graphPanel historyGraphPane" aria-label={t("bs.graphAria")}>{renderCommitGraph()}</section>}
              graphHeight={historyGraphHeight}
              minGraphHeight={HISTORY_GRAPH_HEIGHT.min}
              maxGraphHeight={HISTORY_GRAPH_HEIGHT.max}
              label={t("panel.resizeHistoryGraph")}
              onResizeGraph={setHistoryGraphHeight}
              changes={<section className="historyChangesPane" aria-label={t("hv.changesAria")}>
                {isFullGitObjectId(selectedCommit) && apiRef.current ? <Suspense fallback={<div className="viewEmpty" role="status"><p>{t("hv.loadingCommit")}</p></div>}>
                  <CommitChanges
                    api={apiRef.current}
                    repoId={selectedRepository.repoId}
                    oid={selectedCommit}
                    openPath={historyFilePath}
                    openPathOid={historyFileOid}
                    filesHidden={focusMode}
                    filesSize={{ width: commitFilesWidth, min: COMMIT_FILES_WIDTH.min, max: COMMIT_FILES_WIDTH.max, label: t("panel.resizeCommitFiles"), onResize: setCommitFilesWidth }}
                    onOpenFile={openCommitFileDiff}
                    onOpenDiffWindow={(path, oid) => void openDiffWindow(path, "commit", oid)}
                    actions={!focusMode && renderCommitActions(selectedCommit)}
                    renderDiff={(navigation) => diffTarget?.scope === "commit" ? renderDiffPanel(diffTarget, { fileNavigation: navigation }) : null}
                  />
                </Suspense> : <div className="viewEmpty"><h2>{t("hv.selectCommit")}</h2><p>{t("hv.selectCommitHint")}</p></div>}
              </section>}
            /> : <section className="graphPanel" aria-label={t("bs.graphAria")}>{renderCommitGraph()}</section>}
          </ViewLayout>}
        </WorkspacePage>
      )}

      {settingsView && apiRef.current && <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">{t("load.dialog")}</div>}>
          <SettingsPage api={apiRef.current} repoId={selectedRepository?.repoId} initialSection={settingsView.section} credentialHosts={settingsView.credentialHosts} onClose={closeSettings} shortcuts={shortcuts} onShortcutsChange={setShortcuts} updateStatus={updateStatus} onCheckForUpdates={checkForUpdates} onInstallUpdate={installUpdate} />
        </Suspense>}

      {branchSwitcher.open && <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">{t("load.branchSwitcher")}</div>}>
          <BranchSwitcherDialog
            repository={selectedRepository}
            branchSwitcher={branchSwitcher}
            branches={orderedBranches}
            hasBranchSnapshot={hasBranchSnapshot}
            branchesLoading={activeBranchesLoading}
            branchError={activeBranchError}
            connected={connected}
            hasActiveRepositoryTask={hasActiveRepositoryTask}
            branchSwitcherShortcut={displayShortcut(shortcuts.branchSwitcher, isMacPlatform)}
            shelveShortcut={displayShortcut(shortcuts.shelve, isMacPlatform)}
            shelveAriaShortcut={ariaShortcut(shortcuts.shelve, isMacPlatform)}
            onCommitChanges={() => {
              branchSwitcher.close();
              showCommitComposer();
            }}
            onShelveAndSwitch={() => void branchSwitchShelfFlow.openShelfComposerForBranchSwitch()}
            onChooseWorktreeParent={() => requireGitCrestBridge().chooseCloneParent()}
            onOpenWorktree={(path) => void repositoryOpening.openAtPath(path)}
            api={apiRef.current}
          />
        </Suspense>}

      <CommandPalette
        open={paletteOpen}
        context={paletteContext}
        commands={commands}
        navigationShortcut={commandKey}
        query={paletteQuery}
        onQueryChange={setPaletteQuery}
        onClose={() => setPaletteOpen(false)}
      />

      <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">{t("load.dialog")}</div>}>
      {pushOpen && <PushDialog snapshot={pushPreflight} loading={pushLoading} busy={pushBusy} error={pushError} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} disabledReason={pushDisabledReason} forceWithLeaseOnly={pushForceOnly} onRefresh={() => void refreshPushPreflight()} onFetch={fetchFromPushDialog} onPush={(forceWithLease) => void submitPush(forceWithLease)} onClose={() => setPushOpen(false)} />}
      {pushTargetDialogOpen && <PushTargetDialog remotes={activeRemotes} branches={activeBranches} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask || !canCommit} disabledReason={hasActiveRepositoryTask ? t("app.waitTask") : !canCommit ? t("app.stageFirst") : remoteDisabledReason} onChoose={(target) => { setPushTargetDialogOpen(false); void commitChanges("commitAndPushTo", target); }} onClose={() => setPushTargetDialogOpen(false)} />}
      {pullOpen && <PullDialog snapshot={pullPreflight} loading={pullLoading} busy={pullBusy} error={pullError} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} disabledReason={pullDisabledReason} onRefresh={() => void refreshPullPreflight()} onPull={(strategy) => void submitPull(strategy)} onClose={() => setPullOpen(false)} />}
      {tasksOpen && <TaskCenter api={apiRef.current} tasks={tasks} error={tasksError} actionId={taskActionId} onClose={() => setTasksOpen(false)} onRefresh={() => void refreshTasks()} onCancel={(taskId) => void cancelTask(taskId)} onCopy={(task) => void copyTaskLogs(task)} onRetryClone={(task) => cloneSubmission.retryFromTask(task)} onConfigureCredentials={configureTaskCredentials} onReviewPush={reviewTaskPush} onRecoverWorkflow={(task, _preview, action) => void recoverWorkflow(task, action)} onOpenConflictWindow={(task) => void openConflictWindow(task)} />}
      {discardSelection && <DiscardChangesDialog repositoryPath={discardSelection.repositoryPath} path={discardSelection.path} selectionCount={discardSelection.selections.length} disabled={stagingBusy || hasActiveStagingTask || hasActiveDiscardRepositoryTask} error={tasksError || undefined} onCancel={clearDiscardSelection} onConfirm={() => void discardSelectedChanges()} />}
      {createBranchAt && selectedRepository && apiRef.current && <Suspense fallback={null}><CreateBranchDialog api={apiRef.current} repoId={selectedRepository.repoId} repositoryPath={selectedRepository.path} onChooseFolder={() => requireGitCrestBridge().chooseCloneParent()} startOid={createBranchAt} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setCreateBranchAt(undefined)} onStarted={(task) => { prependTask(task); setCreateBranchAt(undefined); setTasksError(""); setTasksOpen(true); }} /></Suspense>}
      {worktreeForBranch && selectedRepository && apiRef.current && <Suspense fallback={null}><NewWorktreeDialog api={apiRef.current} repoId={selectedRepository.repoId} repositoryPath={selectedRepository.path} branch={worktreeForBranch.name} fromRemote={worktreeForBranch.fromRemote} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onChooseFolder={() => requireGitCrestBridge().chooseCloneParent()} onClose={() => setWorktreeForBranch(undefined)} onStarted={(task) => { prependTask(task); setWorktreeForBranch(undefined); setTasksError(""); setTasksOpen(true); }} /></Suspense>}
      {worktreeFrom && selectedRepository && apiRef.current && <Suspense fallback={null}><CreateBranchDialog api={apiRef.current} repoId={selectedRepository.repoId} repositoryPath={selectedRepository.path} onChooseFolder={() => requireGitCrestBridge().chooseCloneParent()} startOid={worktreeFrom.oid} worktreeFrom={worktreeFrom.label} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setWorktreeFrom(undefined)} onStarted={(task) => { prependTask(task); setWorktreeFrom(undefined); setTasksError(""); setTasksOpen(true); }} /></Suspense>}
      {removeWorktreePath && selectedRepository && apiRef.current && <Suspense fallback={null}><RemoveWorktreeDialog api={apiRef.current} repoId={selectedRepository.repoId} path={removeWorktreePath} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setRemoveWorktreePath(undefined)} onStarted={(task) => { prependTask(task); setRemoveWorktreePath(undefined); setTasksError(""); setTasksOpen(true); }} /></Suspense>}
      {localBranchAction && selectedRepository && apiRef.current && <Suspense fallback={null}><LocalBranchDialog api={apiRef.current} repoId={selectedRepository.repoId} action={localBranchAction} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setLocalBranchAction(undefined)} onStarted={(task) => { prependTask(task); setLocalBranchAction(undefined); setTasksError(""); setTasksOpen(true); }} /></Suspense>}
      {workflowDialog.context && apiRef.current && <WorkflowDialog api={apiRef.current} repoId={workflowDialog.context.repoId} targetOid={workflowDialog.context.targetOid} action={workflowDialog.context.action} targetLabel={workflowDialog.context.targetLabel} onClose={workflowDialog.close} onStarted={workflowDialog.startTask} />}
      {workflowDialog.rebaseOpen && selectedRepository && apiRef.current && <RebaseDialog api={apiRef.current} repoId={selectedRepository.repoId} branches={activeBranches} initialOntoOid={workflowDialog.rebaseOnto} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={workflowDialog.closeRebase} onStarted={(task) => { workflowDialog.closeRebase(); workflowDialog.startTask(task); }} />}
      {workflowDialog.resetOpen && selectedRepository && apiRef.current && <ResetDialog api={apiRef.current} repoId={selectedRepository.repoId} branches={activeBranches} initialTargetOid={workflowDialog.resetTargetOid} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={workflowDialog.closeReset} onStarted={(task) => { workflowDialog.closeReset(); workflowDialog.startTask(task); }} />}
      {remoteBranchDelete.target && selectedRepository && apiRef.current && <RemoteBranchDeleteDialog api={apiRef.current} repoId={selectedRepository.repoId} branchRef={remoteBranchDelete.target} remotes={activeRemotes} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={remoteBranchDelete.close} onStarted={remoteBranchDelete.startTask} />}
      {notice && <div className="appNotice" role="status" aria-live="polite">{notice}</div>}
      {cloneSubmission.dialogOpen && <CloneDialog initialRemoteUrl={cloneSubmission.draft.remoteUrl} initialDirectoryName={cloneSubmission.draft.directoryName} parentPath={cloneSubmission.draft.parentPath} error={cloneSubmission.error} busy={cloneSubmission.busy} onManageAccounts={(draft, hosts) => { cloneSubmission.stashDraft(draft); openAccountSettings(hosts, true); }} onChooseParent={() => requireGitCrestBridge().chooseCloneParent()} onClose={cloneSubmission.closeDialog} onSubmit={(remoteUrl, parentPath, directoryName) => void cloneSubmission.submit(remoteUrl, parentPath, directoryName)} />}
      </Suspense>
    </main>
  );
}

export default App;
