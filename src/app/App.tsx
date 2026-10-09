import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { type GitCrestApiClient, type RepositoryResponse, type TaskSnapshotResponse } from "../api/client";
import { getGitCrestBridge, requireGitCrestBridge } from "../api/bridge";
import { useCoreConnection } from "./use-core-connection";
import { WelcomePage } from "../pages/welcome/WelcomePage";
import { WorkspacePage } from "../pages/workspace/WorkspacePage";
import { WorkspaceNavigation } from "../pages/workspace/WorkspaceNavigation";
import { WorkspaceDetailsPanel } from "../pages/workspace/WorkspaceDetailsPanel";
import { ariaShortcut, displayShortcut, loadSettingsDialog, THEME_CYCLE, useShortcutPreferences, useThemePreference } from "../features/settings";
import { useGlobalShortcuts } from "./use-global-shortcuts";
import { useDialogFocus } from "../shared/hooks/use-dialog-focus";
import { isFullGitObjectId } from "../shared/lib/git-object-id";
import { getRepositoryDisplayName } from "../shared/lib/repository-display-name";
import { ResizeSeparator } from "../shared/ui/ResizeSeparator";
import type { CredentialEditorRenderer } from "../shared/ui/credential-editor-renderer";
import { getSensitiveStagedPaths, loadCommitWorkbench, useCommitDraft, useCommitSubmission, type CommitAction } from "../features/commits";
import { loadCloneDialog, useCloneSubmission } from "../features/cloning";
import { loadCredentialEditor } from "../features/credentials";
import { getRepositoryEventRefreshPlan, useRepositoryCacheLifecycle, useRepositoryListRefresh, useRepositoryMutations, useRepositoryOpening, useRepositoryTabLifecycle, useWorkspaceCommitAction, useWorkspaceCommitSelection, useWorkspaceGraphScroll, useWorkspaceLayout, useWorkspaceSessionActions, useWorkspaceSessionState, type WorkspaceMode } from "../features/repositories";
import { summarizeRepositoryStatus, useRepositoryStatus, useStagingOperations } from "../features/changes";
import { useHistoryViewRequests } from "../features/history";
import { loadDiscardChangesDialog, useRepositoryDiffQuery } from "../features/diff";
import { loadBranchSwitcherDialog, loadRemoteBranchDeleteDialog, useBranchSwitchShelfFlow, useBranchSwitcher, useRemoteBranchDeleteSession, useRepositoryRefs } from "../features/branches";
import { loadTaskCenter, useTaskCenter, useTaskRefreshEffects, useTaskRefreshLifecycle } from "../features/tasks";
import { getRemoteActionDisabledReasons, loadPullDialog, loadPushDialog, loadPushTargetDialog, useRemoteMutations, useRepositoryFetch, useRepositoryPull, useRepositoryPush, type PushTarget } from "../features/remotes";
import { loadRebaseDialog, loadResetDialog, loadWorkflowDialog, useOpenConflictWindow, useWorkflowDialogSession, useWorkflowRecovery } from "../features/workflows";
import type { UpdateStatus } from "../api/update-status";
import "../App.css";

const TaskCenter = lazy(() => loadTaskCenter().then(({ TaskCenter }) => ({ default: TaskCenter })));
const WorkflowDialog = lazy(() => loadWorkflowDialog().then(({ WorkflowDialog }) => ({ default: WorkflowDialog })));
const RebaseDialog = lazy(() => loadRebaseDialog().then(({ RebaseDialog }) => ({ default: RebaseDialog })));
const ResetDialog = lazy(() => loadResetDialog().then(({ ResetDialog }) => ({ default: ResetDialog })));
const RemoteBranchDeleteDialog = lazy(() => loadRemoteBranchDeleteDialog().then(({ RemoteBranchDeleteDialog }) => ({ default: RemoteBranchDeleteDialog })));
const BranchSwitcherDialog = lazy(() => loadBranchSwitcherDialog().then(({ BranchSwitcherDialog }) => ({ default: BranchSwitcherDialog })));
const CloneDialog = lazy(() => loadCloneDialog().then(({ CloneDialog }) => ({ default: CloneDialog })));
const WorkspaceMainPanel = lazy(() => import("../pages/workspace/WorkspaceMainPanel").then(({ WorkspaceMainPanel }) => ({ default: WorkspaceMainPanel })));
const PushDialog = lazy(() => loadPushDialog().then(({ PushDialog }) => ({ default: PushDialog })));
const PullDialog = lazy(() => loadPullDialog().then(({ PullDialog }) => ({ default: PullDialog })));
const PushTargetDialog = lazy(() => loadPushTargetDialog().then(({ PushTargetDialog }) => ({ default: PushTargetDialog })));
const DiscardChangesDialog = lazy(() => loadDiscardChangesDialog().then(({ DiscardChangesDialog }) => ({ default: DiscardChangesDialog })));
const SettingsDialog = lazy(() => loadSettingsDialog().then(({ SettingsDialog }) => ({ default: SettingsDialog })));
const CommitWorkbench = lazy(() => loadCommitWorkbench().then(({ CommitWorkbench }) => ({ default: CommitWorkbench })));
const CredentialEditor = lazy(() => loadCredentialEditor().then(({ CredentialEditor }) => ({ default: CredentialEditor })));

type Page = "welcome" | "workspace";

function App() {
  const isMacPlatform = navigator.platform.toLowerCase().includes("mac");
  const commandKey = isMacPlatform ? "⌘" : "Ctrl";
  const [repositories, setRepositories] = useState<RepositoryResponse[]>([]);
  const [selectedRepository, setSelectedRepository] = useState<RepositoryResponse>();
  const [credentialManagerOpenRequest, setCredentialManagerOpenRequest] = useState(0);
  const [pushTargetDialogOpen, setPushTargetDialogOpen] = useState(false);
  const historyRequests = useHistoryViewRequests();
  const [shelfComposerRequest, setShelfComposerRequest] = useState<{ id: number; repoId?: string }>({ id: 0 });
  const [tasksOpen, setTasksOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>();
  const { shortcuts, setShortcuts } = useShortcutPreferences();
  const {
    message: commitMessage,
    setMessage: setCommitMessage,
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
  const { apiRef, status, version, setStatus } = useCoreConnection({
    onConnected: (api) => refreshRepositories(api, true),
    onEvent: (api, event, sequenceGap, isActive) => {
      const plan = getRepositoryEventRefreshPlan(
        event,
        sequenceGap,
        selectedRepositoryRef.current?.repoId,
        isRepositoryTabOpen,
      );
      if (!plan) return;
      if (plan.refreshRepositories) {
        void refreshRepositories(api).catch((syncError: unknown) => {
          if (plan.reportRepositoryRefreshError && isActive()) {
            setStatus(syncError instanceof Error ? syncError.message : "Failed to refresh repository state");
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
  const [page, setPage] = useState<Page>("welcome");
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
    requestShelfComposer: (repoId) => setShelfComposerRequest((request) => ({ id: request.id + 1, repoId })),
    onBranchSwitchReview: branchSwitcher.reviewAfterShelf,
    appendTask: prependTask,
    setTaskError: setTasksError,
    openTaskCenter: () => setTasksOpen(true),
  });
  const mode = selectedRepository ? workspaceSession.tabs[selectedRepository.repoId]?.mode || "graph" : "graph";
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
  const graphViewportRef = useRef<HTMLDivElement>(null);
  const { theme, nextTheme } = useThemePreference();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const { dialogRef: paletteRef, onKeyDown: onPaletteFocusKeyDown } = useDialogFocus<HTMLElement>(() => setPaletteOpen(false), false, undefined, paletteOpen);
  const { sidebarWidth, setSidebarWidth, detailsWidth, setDetailsWidth, workbenchHeight, setWorkbenchHeight } = useWorkspaceLayout(selectedRepository?.repoId);
  useEffect(() => {
    const bridge = getGitCrestBridge();
    const getStatus = bridge?.getUpdateStatus;
    const subscribe = bridge?.subscribeToUpdateStatus;
    if (!getStatus || !subscribe) return;

    let active = true;
    const unsubscribe = subscribe((next) => {
      if (active) setUpdateStatus(next);
    });
    void getStatus().then((next) => {
      if (active) setUpdateStatus(next);
    }).catch(() => {
      if (active) setUpdateStatus({ state: "error", message: "Update status could not be loaded." });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const connected = status === "Connected to local Rust core";
  const connecting = status.startsWith("Starting");
  const connectionLabel = connected ? "Core connected" : connecting ? "Starting core" : "Core unavailable";
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
  const selectedDiffCommitOid = activeTabState?.selectedDiffCommitOid;
  const selectedDiffFile = (activeStatus?.files || []).find((file) => file.path === selectedFilePath);
  const diffQuery = useRepositoryDiffQuery({
    api: apiRef.current,
    mode,
    repository: selectedRepository,
    path: selectedFilePath,
    scope: selectedFileScope,
    commitOid: selectedDiffCommitOid,
  });
  const { state: diffState, activeKey: activeDiffKey } = diffQuery;
  const { groups: statusGroups, stagedCount, hasConflicts, workingCount } = summarizeRepositoryStatus(activeStatus);
  const sensitiveStagedPaths = getSensitiveStagedPaths(activeStatus);
  const hasActiveTasks = tasks.some((task) => task.status === "queued" || task.status === "running");
  const hasActiveRepositoryTask = tasks.some((task) => task.repoId === selectedRepository?.repoId && (task.status === "queued" || task.status === "running"));
  const { remoteDisabledReason, pushDisabledReason, pullDisabledReason } = getRemoteActionDisabledReasons({
    repository: selectedRepository,
    connected,
    hasActiveRepositoryTask,
  });
  const commitActionLabel = amendCommit
    ? activeCommitAction === "commit" ? "Amend" : activeCommitAction === "commitAndPushTo" ? "Amend and Push to…" : "Amend and Push"
    : activeCommitAction === "commit" ? "Commit" : activeCommitAction === "commitAndPushTo" ? "Commit and Push to…" : activeCommitAction === "commitAndPushForce" ? "Commit and Push (force-with-lease)" : "Commit and Push";
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
  const canCommit = Boolean(selectedRepository && activeStatus && stagedCount > 0 && !hasConflicts && commitMessage.trim() && connected && !commitBusy && !hasActiveRepositoryTask && (!commitSelections.length || commitSelectionRepoId === selectedRepository.repoId));
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

  function addDiffSelectionToCommit(selections: Array<{ hunkIndex: number; rowIndex?: number }>) {
    const document = diffState.document;
    if (!selectedRepository || !document || document.scope !== "index") return;
    addCommitDiffSelection(document.path, document.revision, selections);
  }

  function configureTaskCredentials(task: TaskSnapshotResponse) {
    if (task.repoId) {
      const repository = repositories.find((entry) => entry.repoId === task.repoId);
      if (repository) activateRepository(repository);
    }
    setTasksOpen(false);
    setCredentialManagerOpenRequest((current) => current + 1);
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
      if (plan.kind !== "commit") return;
      const commitContext = commitSubmission.takeTaskContext(task.taskId);
      if (task.status === "succeeded" && commitContext?.message === commitMessage) setCommitMessage("");
      if (task.status === "succeeded" && commitContext?.selections === JSON.stringify(commitSelections)) {
        setCommitSelections([]);
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
    openDiff: () => changeWorkspaceMode("diff"),
    searchCommits: (repoId) => {
      changeWorkspaceMode("graph");
      historyRequests.focusSearch(repoId);
    },
    openShelfComposer: () => {
      if (!selectedRepository) return;
      setShelfComposerRequest((request) => ({ id: request.id + 1, repoId: selectedRepository.repoId }));
    },
    cherryPick: (repoId, targetOid) => workflowDialog.open(repoId, targetOid, "cherryPick"),
    createTag: (repoId, oid) => {
      changeWorkspaceMode("graph");
      historyRequests.openTagEditor(repoId, oid);
    },
    openSettings: () => setSettingsOpen(true),
    commit: () => { void commitChanges("commit"); },
    commitAndPush: () => { void commitChanges("commitAndPush"); },
    pull: openPullDialog,
    rebase: workflowDialog.openRebase,
    openBranchSwitcher: branchSwitcher.openSwitcher,
    toggleCommandPalette: () => {
      setPaletteOpen((open) => !open);
      setPaletteQuery("");
    },
    openCommitAssistant: () => setCommitAssistantOpen(true),
    closeCommandPalette: () => setPaletteOpen(false),
  });

  const layoutStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--details-width": `${detailsWidth}px`,
    "--workbench-height": `${workbenchHeight}px`,
  } as CSSProperties;
  const renderCredentialEditor: CredentialEditorRenderer = (host, disabled) => (
    <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">Loading credential controls…</div>}>
      <CredentialEditor key={host} api={apiRef.current} host={host} disabled={disabled} />
    </Suspense>
  );

  const commands = [
    { id: "welcome", label: "Go to Welcome", detail: "Return to recent repositories and quick actions", available: true, run: () => setPage("welcome") },
    { id: "workspace", label: "Go to Workspace", detail: "Open the Changes, Graph, and Commit workspace", available: true, run: () => setPage("workspace") },
    { id: "theme", label: "Cycle color theme", detail: `Current: ${theme}; next: ${THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]}`, available: true, run: nextTheme },
    { id: "open", label: "Open local repository", detail: "Choose a local Git repository folder", available: true, run: () => { void repositoryOpening.chooseAndOpenLocal(); } },
    { id: "fetch", label: "Fetch from remotes", detail: "Start a cancellable fetch task", available: Boolean(selectedRepository), run: () => { void fetchRepository(); } },
    { id: "pull", label: "Pull current branch", detail: "Review worktree state and choose merge or rebase", available: Boolean(selectedRepository), run: () => openPullDialog() },
    { id: "rebase", label: "Interactive rebase", detail: `Review, reorder, and edit the current branch commit sequence (${displayShortcut(shortcuts.rebase, isMacPlatform)})`, available: Boolean(selectedRepository && activeBranches && connected), run: workflowDialog.openRebase },
    { id: "reset", label: "Reset current branch", detail: "Review commit and file impact before moving HEAD", available: Boolean(selectedRepository && activeBranches && connected), run: workflowDialog.openReset },
    { id: "push", label: "Push current branch", detail: "Review commits, target, and overwrite scope before pushing", available: Boolean(selectedRepository), run: () => openPushDialog() },
    { id: "ai-commit-message", label: "Generate commit message suggestion", detail: `Review staged diffs and ask the configured AI provider (${displayShortcut(shortcuts.aiCommitMessage, isMacPlatform)})`, available: Boolean(selectedRepository && stagedCount > 0 && !hasConflicts && !commitBusy), run: () => setCommitAssistantOpen(true) },
    { id: "clone", label: "Clone repository", detail: "Clone a remote using Git credentials", available: connected, run: () => cloneSubmission.openDialog() },
    { id: "diff", label: "Open Diff view", detail: "Review the selected changed file", available: Boolean(selectedFilePath), run: () => changeWorkspaceMode("diff") },
  ];
  const filteredCommands = commands.filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(paletteQuery.toLowerCase()));

  return (
    <main className="appShell" style={layoutStyle}>
      <header className="titlebar">
        <button className="brandButton" type="button" onClick={() => setPage("welcome")} aria-label="Go to Welcome">
          <span className="brandMark" aria-hidden="true">G</span>
          <span className="brandName">GitCrest</span>
        </button>
        <nav className="pageTabs" aria-label="Primary navigation">
          <button type="button" className={page === "welcome" ? "pageTab active" : "pageTab"} onClick={() => setPage("welcome")}>Welcome</button>
          <button type="button" className={page === "workspace" ? "pageTab active" : "pageTab"} onClick={() => setPage("workspace")}>Workspace</button>
        </nav>
        <div className="repositoryTabs" role="tablist" aria-label="Open repositories">
          {workspaceSession.openRepoIds.map((repoId) => {
            const repository = repositories.find((item) => item.repoId === repoId);
            if (!repository) return null;
            const active = selectedRepository?.repoId === repoId;
            return (
              <div className={active ? "repositoryTab active" : "repositoryTab"} key={repoId}>
                <button type="button" role="tab" aria-selected={active} title={repository.path} onClick={() => { if (!active) void repositoryOpening.openRecent(repository); }}>
                  {getRepositoryDisplayName(repository.path)}
                </button>
                <button type="button" className="closeRepositoryTab" aria-label={`Close ${getRepositoryDisplayName(repository.path)} tab`} title="Close tab" onClick={() => closeRepositoryTab(repoId)}>×</button>
              </div>
            );
          })}
        </div>
        <div className="titlebarSpacer" />
        <button className="quietButton searchShortcut" type="button" onClick={() => setPaletteOpen(true)} aria-keyshortcuts={ariaShortcut(shortcuts.commandPalette, isMacPlatform)}>
          <span aria-hidden="true">⌕</span><span>Search commands</span><kbd>{displayShortcut(shortcuts.commandPalette, isMacPlatform)}</kbd>
        </button>
        <button className="quietButton themeButton" type="button" onClick={nextTheme} aria-label={`Color theme: ${theme}. Activate to cycle theme`} title={`Theme: ${theme}`}>
          <span aria-hidden="true">◐</span><span>{theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}</span>
        </button>
        <button className="quietButton taskCenterButton" type="button" onClick={() => setTasksOpen(true)} aria-label={`Background tasks, ${tasks.filter((task) => task.status === "queued" || task.status === "running").length} active`}>
          Tasks <span className="countBadge">{tasks.filter((task) => task.status === "queued" || task.status === "running").length}</span>
        </button>
        <button className="quietButton" type="button" onClick={() => setSettingsOpen(true)} aria-keyshortcuts={ariaShortcut(shortcuts.settings, isMacPlatform)} title={`Settings (${displayShortcut(shortcuts.settings, isMacPlatform)})`}>Settings</button>
        <div className={`connectionBadge ${connected ? "connected" : ""}`} role="status" aria-live="polite" aria-label={status} title={status}>
          <span className="connectionDot" aria-hidden="true" />
          <span>{connectionLabel}</span>
        </div>
      </header>

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
          selectedRepository={selectedRepository}
          selectedFilePath={selectedFilePath}
          mode={mode}
          shortcuts={shortcuts}
          isMacPlatform={isMacPlatform}
          connected={connected}
          connecting={connecting}
          version={version}
          hasActiveRepositoryTask={hasActiveRepositoryTask}
          pushDisabledReason={pushDisabledReason}
          pullDisabledReason={pullDisabledReason}
          onChangeWorkspaceMode={changeWorkspaceMode}
          onOpenPushDialog={openPushDialog}
          onOpenPullDialog={openPullDialog}
          onFetchRepository={() => void fetchRepository()}
          onOpenBranchSwitcher={branchSwitcher.openSwitcher}
        >
          <div className={`workArea${mode === "diff" ? " diffMode" : ""}`}>
            <WorkspaceNavigation
              selectedRepository={selectedRepository}
              activeStatus={activeStatus}
              activeStatusError={activeStatusError}
              activeStatusLoading={activeStatusLoading}
              statusGroups={statusGroups}
              workingCount={workingCount}
              stagedCount={stagedCount}
              stagingBusy={stagingBusy}
              hasActiveStagingTask={hasActiveStagingTask}
              selectedFilePath={selectedFilePath}
              selectedFileScope={selectedFileScope}
              activeBranches={activeBranches}
              hasBranchSnapshot={hasBranchSnapshot}
              activeBranchError={activeBranchError}
              activeBranchesLoading={activeBranchesLoading}
              orderedBranches={orderedBranches}
              activeRemotes={activeRemotes}
              activeRemoteError={activeRemoteError}
              activeRemotesLoading={activeRemotesLoading}
              remoteActionBusy={remoteMutations.busy}
              remoteDisabledReason={remoteDisabledReason}
              api={apiRef.current}
              renderCredentialEditor={renderCredentialEditor}
              credentialManagerOpenRequest={credentialManagerOpenRequest}
              historyRefreshKey={historyRequests.refreshKey}
              shelfComposerRequest={shelfComposerRequest.repoId === selectedRepository?.repoId ? shelfComposerRequest.id : 0}
              shelfComposerAfterSwitch={branchSwitchShelfFlow.shelfComposerAfterSwitch?.repoId === selectedRepository?.repoId ? branchSwitchShelfFlow.shelfComposerAfterSwitch : undefined}
              connected={connected}
              connecting={connecting}
              hasActiveRepositoryTask={hasActiveRepositoryTask}
              shortcuts={shortcuts}
              isMacPlatform={isMacPlatform}
              onStageChanges={(action, path) => void stageChanges(action, path)}
              onRefreshRepositoryStatus={(repoId, force) => void refreshRepositoryStatus(repoId, force)}
              onRefreshRepositoryBranches={(repoId) => void refreshRepositoryBranches(repoId)}
              onOpenFileDiff={openFileDiff}
              onDeleteRemoteBranch={remoteBranchDelete.open}
              onToggleBranchFavorite={(fullName, favorite) => void toggleBranchFavorite(selectedRepository?.repoId, fullName, favorite)}
              onFetchRepository={() => void fetchRepository()}
              onRefreshRepositoryRemotes={(repoId) => void refreshRepositoryRemotes(repoId)}
              onAddRepositoryRemote={remoteMutations.addRepositoryRemote}
              onSetRepositoryRemoteUrl={remoteMutations.setRepositoryRemoteUrl}
              onDeleteRepositoryRemote={remoteMutations.deleteRepositoryRemote}
              onSetRepositoryDefaultRemote={remoteMutations.setRepositoryDefaultRemote}
              onSetRepositoryBranchUpstream={remoteMutations.setRepositoryBranchUpstream}
              onShelfTaskSubmitted={(task, switchTarget) => {
                if (selectedRepository) void refreshRepositoryStatus(selectedRepository.repoId);
                if (task) {
                  prependTask(task);
                }
                branchSwitchShelfFlow.onShelfComposerTaskSubmitted(task, switchTarget);
                void refreshTasks();
              }}
              onShelfComposerClosed={branchSwitchShelfFlow.onShelfComposerClosed}
            />
            <ResizeSeparator orientation="vertical" edge="left" value={sidebarWidth} min={190} max={340} label="Resize repository navigation" onResize={setSidebarWidth} />

            <Suspense fallback={<section className="mainPanel" aria-label={mode === "graph" ? "Commit graph" : "File diff"}><div className="graphViewport" role="status" aria-live="polite">Loading workspace view…</div></section>}>
              <WorkspaceMainPanel
                mode={mode}
                repository={selectedRepository}
                api={apiRef.current}
                statusLoading={activeStatusLoading}
                shortcuts={shortcuts}
                isMacPlatform={isMacPlatform}
                selectedCommit={selectedCommit}
                workspaceSession={workspaceSession}
                historyRefreshKey={historyRequests.refreshKey}
              historySearchFocusRequest={historyRequests.searchFocusRequest}
                graphViewportRef={graphViewportRef}
                openingRepository={repositoryOpening.opening}
                selectedFilePath={selectedFilePath}
                selectedFileScope={selectedFileScope}
                selectedDiffCommitOid={selectedDiffCommitOid}
                activeDiffKey={activeDiffKey}
                diffState={diffState}
                selectedDiffFile={selectedDiffFile}
                stagingBusy={stagingBusy}
                hasActiveStagingTask={hasActiveStagingTask}
                commitBusy={commitBusy}
                version={version}
                onRefreshStatus={(repoId, force) => void refreshRepositoryStatus(repoId, force)}
              onFocusSearchHandled={historyRequests.markSearchFocusHandled}
                onGraphScrollPosition={rememberGraphScroll}
                onSelectCommit={selectCommit}
                onOpenRepository={() => void repositoryOpening.chooseAndOpenLocal()}
                onRetryDiff={diffQuery.retry}
                onStageSelection={stageSelectedChanges}
                onDiscardSelection={requestDiscard}
                onCommitSelection={addDiffSelectionToCommit}
                onOpenDiffWindow={(path, scope, oid) => void openDiffWindow(path, scope, oid)}
              />
            </Suspense>
            {mode === "graph" && <ResizeSeparator orientation="vertical" edge="right" value={detailsWidth} min={220} max={420} label="Resize commit details" onResize={setDetailsWidth} />}

            {mode === "graph" && <WorkspaceDetailsPanel
              repository={selectedRepository}
              selectedCommit={selectedCommit}
              api={apiRef.current}
              connected={connected}
              hasActiveRepositoryTask={hasActiveRepositoryTask}
              openTagRequest={historyRequests.tagEditorRequest}
              shortcuts={shortcuts}
              isMacPlatform={isMacPlatform}
              onOpenFile={openCommitFileDiff}
              onOpenDiffWindow={(path, oid) => void openDiffWindow(path, "commit", oid)}
              onTagRequestHandled={historyRequests.markTagEditorHandled}
              onWorkflow={(action, oid) => { if (selectedRepository) workflowDialog.open(selectedRepository.repoId, oid, action); }}
            />}
          </div>

          <ResizeSeparator orientation="horizontal" edge="bottom" value={workbenchHeight} min={144} max={360} label="Resize changes and commit area" onResize={setWorkbenchHeight} />
          <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">Loading commit controls…</div>}>
            <CommitWorkbench
              repository={selectedRepository}
              status={{ snapshot: activeStatus, error: activeStatusError, loading: activeStatusLoading, workingCount, stagedCount, hasConflicts, sensitiveStagedPaths }}
              commit={{ message: commitMessage, template: commitTemplate, selections: commitSelections, selectionRepoId: commitSelectionRepoId, activeAction: activeCommitAction, actionLabel: commitActionLabel, actionIsDanger: commitActionIsDanger, actionMenuOpen: commitActionMenuOpen, assistantOpen: commitAssistantOpen, amend: amendCommit, signOff: signOffCommit, sign: signCommit, busy: commitBusy, canCommit }}
              shortcuts={shortcuts}
              isMacPlatform={isMacPlatform}
              connected={connected}
              hasActiveRepositoryTask={hasActiveRepositoryTask}
              api={apiRef.current}
              onChangeMessage={setCommitMessage}
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
          </Suspense>

        </WorkspacePage>
      )}

      {branchSwitcher.open && <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">Loading branch switcher…</div>}>
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
              requestAnimationFrame(() => document.getElementById("commit-message")?.focus());
            }}
            onShelveAndSwitch={() => void branchSwitchShelfFlow.openShelfComposerForBranchSwitch()}
          />
        </Suspense>}

      {paletteOpen && (
        <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaletteOpen(false); }}>
          <section
            ref={paletteRef}
            className="commandPalette"
            role="dialog"
            aria-modal="true"
            aria-labelledby="palette-title"
            onKeyDown={(event) => {
              onPaletteFocusKeyDown(event);
              if (event.defaultPrevented) return;
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".commandItem:not(:disabled)"));
              if (items.length === 0) return;
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "Enter") {
                event.preventDefault();
                (current >= 0 ? items[current] : items[0]).click();
                return;
              }
              event.preventDefault();
              const next = event.key === "ArrowDown"
                ? (current + 1) % items.length
                : (current <= 0 ? items.length - 1 : current - 1);
              items[next].focus();
            }}
          >
            <h2 id="palette-title" className="srOnly">Command palette</h2>
            <div className="paletteSearch"><span aria-hidden="true">⌕</span><input autoFocus data-dialog-initial-focus aria-label="Search commands" placeholder="Search commands…" value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} /><kbd>ESC</kbd></div>
          <div className="paletteContext">{page === "welcome" ? "WELCOME" : selectedRepository ? `WORKSPACE · ${getRepositoryDisplayName(selectedRepository.path).toUpperCase()}` : "WORKSPACE · NO REPOSITORY"}</div>
            <div className="commandList">
              {filteredCommands.map((command) => (
                <button key={command.id} className="commandItem" type="button" disabled={!command.available} onClick={() => { command.run(); setPaletteOpen(false); }}>
                  <span className="commandItemMain"><strong>{command.label}</strong><small>{command.detail}</small></span>
                  {command.available ? <kbd>{command.id === "workspace" ? `${commandKey} 2` : command.id === "welcome" ? `${commandKey} 1` : "↵"}</kbd> : <span className="unavailableTag">Unavailable</span>}
                </button>
              ))}
              {filteredCommands.length === 0 && <p className="noCommands">No commands match “{paletteQuery}”.</p>}
            </div>
            <div className="paletteFooter"><span>↑ ↓ Navigate</span><span>Enter Run command</span><span>Esc Close</span></div>
          </section>
        </div>
      )}

      <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">Loading dialog…</div>}>
      {pushOpen && <PushDialog snapshot={pushPreflight} loading={pushLoading} busy={pushBusy} error={pushError} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} disabledReason={pushDisabledReason} forceWithLeaseOnly={pushForceOnly} onRefresh={() => void refreshPushPreflight()} onFetch={fetchFromPushDialog} onPush={(forceWithLease) => void submitPush(forceWithLease)} onClose={() => setPushOpen(false)} />}
      {pushTargetDialogOpen && <PushTargetDialog remotes={activeRemotes} branches={activeBranches} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask || !canCommit} disabledReason={hasActiveRepositoryTask ? "Wait for the current repository task." : !canCommit ? "Stage changes and enter a commit message first." : remoteDisabledReason} onChoose={(target) => { setPushTargetDialogOpen(false); void commitChanges("commitAndPushTo", target); }} onClose={() => setPushTargetDialogOpen(false)} />}
      {pullOpen && <PullDialog snapshot={pullPreflight} loading={pullLoading} busy={pullBusy} error={pullError} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} disabledReason={pullDisabledReason} onRefresh={() => void refreshPullPreflight()} onPull={(strategy) => void submitPull(strategy)} onClose={() => setPullOpen(false)} />}
      {tasksOpen && <TaskCenter api={apiRef.current} tasks={tasks} error={tasksError} actionId={taskActionId} onClose={() => setTasksOpen(false)} onRefresh={() => void refreshTasks()} onCancel={(taskId) => void cancelTask(taskId)} onCopy={(task) => void copyTaskLogs(task)} onRetryClone={(task) => cloneSubmission.retryFromTask(task)} onConfigureCredentials={configureTaskCredentials} onReviewPush={reviewTaskPush} onRecoverWorkflow={(task, _preview, action) => void recoverWorkflow(task, action)} onOpenConflictWindow={(task) => void openConflictWindow(task)} />}
      {settingsOpen && apiRef.current && <SettingsDialog api={apiRef.current} repoId={selectedRepository?.repoId} onClose={() => setSettingsOpen(false)} shortcuts={shortcuts} onShortcutsChange={setShortcuts} updateStatus={updateStatus} onCheckForUpdates={async () => {
        const check = getGitCrestBridge()?.checkForUpdates;
        if (!check) return;
        try { setUpdateStatus(await check()); }
        catch { setUpdateStatus({ state: "error", message: "The update check failed. Try again later." }); }
      }} onInstallUpdate={() => {
        const install = getGitCrestBridge()?.installUpdate;
        if (install) void install().catch(() => setUpdateStatus({ state: "error", message: "The update could not be installed." }));
      }} />}
      {discardSelection && <DiscardChangesDialog repositoryPath={discardSelection.repositoryPath} path={discardSelection.path} selectionCount={discardSelection.selections.length} disabled={stagingBusy || hasActiveStagingTask || hasActiveDiscardRepositoryTask} error={tasksError || undefined} onCancel={clearDiscardSelection} onConfirm={() => void discardSelectedChanges()} />}
      {workflowDialog.context && apiRef.current && <WorkflowDialog api={apiRef.current} repoId={workflowDialog.context.repoId} targetOid={workflowDialog.context.targetOid} action={workflowDialog.context.action} onClose={workflowDialog.close} onStarted={workflowDialog.startTask} />}
      {workflowDialog.rebaseOpen && selectedRepository && apiRef.current && <RebaseDialog api={apiRef.current} repoId={selectedRepository.repoId} branches={activeBranches} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={workflowDialog.closeRebase} onStarted={(task) => { workflowDialog.closeRebase(); workflowDialog.startTask(task); }} />}
      {workflowDialog.resetOpen && selectedRepository && apiRef.current && <ResetDialog api={apiRef.current} repoId={selectedRepository.repoId} branches={activeBranches} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={workflowDialog.closeReset} onStarted={(task) => { workflowDialog.closeReset(); workflowDialog.startTask(task); }} />}
      {remoteBranchDelete.target && selectedRepository && apiRef.current && <RemoteBranchDeleteDialog api={apiRef.current} repoId={selectedRepository.repoId} branchRef={remoteBranchDelete.target} remotes={activeRemotes} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={remoteBranchDelete.close} onStarted={remoteBranchDelete.startTask} />}
      {cloneSubmission.dialogOpen && <CloneDialog initialRemoteUrl={cloneSubmission.draft.remoteUrl} initialDirectoryName={cloneSubmission.draft.directoryName} parentPath={cloneSubmission.draft.parentPath} error={cloneSubmission.error} busy={cloneSubmission.busy} renderCredentialEditor={renderCredentialEditor} onChooseParent={() => requireGitCrestBridge().chooseCloneParent()} onClose={cloneSubmission.closeDialog} onSubmit={(remoteUrl, parentPath, directoryName) => void cloneSubmission.submit(remoteUrl, parentPath, directoryName)} />}
      </Suspense>
    </main>
  );
}

export default App;
