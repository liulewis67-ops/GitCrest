import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { GitCrestApiError, type DiffDocumentResponse, type GitCrestApiClient, type RepositoryResponse, type TaskSnapshotResponse, type WorkflowRecoveryPreflightResponse } from "../api/client";
import { getGitCrestBridge, requireGitCrestBridge } from "../api/bridge";
import { useCoreConnection } from "./use-core-connection";
import { WelcomePage } from "../pages/welcome/WelcomePage";
import { WorkspacePage } from "../pages/workspace/WorkspacePage";
import { WorkspaceNavigation } from "../pages/workspace/WorkspaceNavigation";
import { WorkspaceDetailsPanel } from "../pages/workspace/WorkspaceDetailsPanel";
import type { WorkflowAction } from "../features/workflows/WorkflowDialog";
import type { PushTarget } from "../features/remotes/PushTargetDialog";
import { ariaShortcut, displayShortcut, THEME_CYCLE, useShortcutPreferences, useThemePreference } from "../features/settings";
import { useGlobalShortcuts } from "./use-global-shortcuts";
import { useDialogFocus } from "../shared/use-dialog-focus";
import { ResizeSeparator } from "../shared/ui/ResizeSeparator";
import { loadCommitWorkbench, useCommitDraft, useCommitSubmission } from "../features/commits";
import { loadCloneDialog, useCloneSubmission } from "../features/cloning";
import { loadWorkspaceSession, saveWorkspaceSession, useWorkspaceCommitAction, useWorkspaceCommitSelection, useWorkspaceGraphScroll, useWorkspaceLayout, type CommitAction, type WorkspaceMode, type WorkspaceSession } from "../features/repositories";
import { useRepositoryStatus, useStagingOperations } from "../features/changes";
import { useRepositoryRefs } from "../features/branches/model/use-repository-refs";
import { useTaskCenter } from "../features/tasks/model/use-task-center";
import { useTaskRefreshLifecycle } from "../features/tasks/model/use-task-refresh-lifecycle";
import { TaskRefreshPlanner } from "../features/tasks/model/task-refresh-planner";
import { useRemoteMutations, useRepositoryFetch, useRepositoryPull, useRepositoryPush } from "../features/remotes";
import { getRepositoryEventRefreshPlan } from "../features/repositories/model/repository-event-refresh-plan";
import type { components } from "../api/schema";
import type { UpdateStatus } from "../api/update-status";
import "../App.css";

const TaskCenter = lazy(() => import("../features/tasks/TaskCenter").then(({ TaskCenter }) => ({ default: TaskCenter })));
const WorkflowDialog = lazy(() => import("../features/workflows/WorkflowDialog").then(({ WorkflowDialog }) => ({ default: WorkflowDialog })));
const RebaseDialog = lazy(() => import("../features/workflows/RebaseDialog").then(({ RebaseDialog }) => ({ default: RebaseDialog })));
const ResetDialog = lazy(() => import("../features/workflows/ResetDialog").then(({ ResetDialog }) => ({ default: ResetDialog })));
const RemoteBranchDeleteDialog = lazy(() => import("../features/branches/RemoteBranchDeleteDialog").then(({ RemoteBranchDeleteDialog }) => ({ default: RemoteBranchDeleteDialog })));
const CloneDialog = lazy(() => loadCloneDialog().then(({ CloneDialog }) => ({ default: CloneDialog })));
const WorkspaceMainPanel = lazy(() => import("../pages/workspace/WorkspaceMainPanel").then(({ WorkspaceMainPanel }) => ({ default: WorkspaceMainPanel })));
const PushDialog = lazy(() => import("../features/remotes/PushDialog").then(({ PushDialog }) => ({ default: PushDialog })));
const PullDialog = lazy(() => import("../features/remotes/PullDialog").then(({ PullDialog }) => ({ default: PullDialog })));
const PushTargetDialog = lazy(() => import("../features/remotes/PushTargetDialog").then(({ PushTargetDialog }) => ({ default: PushTargetDialog })));
const DiscardChangesDialog = lazy(() => import("../features/diff/DiscardChangesDialog").then(({ DiscardChangesDialog }) => ({ default: DiscardChangesDialog })));
const SettingsDialog = lazy(() => import("../features/settings/SettingsDialog").then(({ SettingsDialog }) => ({ default: SettingsDialog })));
const CommitWorkbench = lazy(() => loadCommitWorkbench().then(({ CommitWorkbench }) => ({ default: CommitWorkbench })));

type Page = "welcome" | "workspace";
const changeGroups = [
  { category: "staged", label: "Staged" },
  { category: "unstaged", label: "Unstaged" },
  { category: "untracked", label: "Untracked" },
  { category: "conflicted", label: "Conflicted" },
  { category: "ignored", label: "Ignored" },
] as const;

function repositoryName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function isFullObjectId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function App() {
  const isMacPlatform = navigator.platform.toLowerCase().includes("mac");
  const commandKey = isMacPlatform ? "⌘" : "Ctrl";
  const [repositories, setRepositories] = useState<RepositoryResponse[]>([]);
  const [selectedRepository, setSelectedRepository] = useState<RepositoryResponse>();
  const [credentialManagerOpenRequest, setCredentialManagerOpenRequest] = useState(0);
  const [pushTargetDialogOpen, setPushTargetDialogOpen] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [historySearchFocusRequest, setHistorySearchFocusRequest] = useState<{ repoId: string; sequence: number }>();
  const [tagEditorRequest, setTagEditorRequest] = useState<{ repoId: string; oid: string; sequence: number }>();
  const [shelfComposerRequest, setShelfComposerRequest] = useState(0);
  const [shelfComposerAfterSwitch, setShelfComposerAfterSwitch] = useState<{ repoId: string; target: string; existingShelfIds: string[] }>();
  const autoSwitchAfterShelfRef = useRef(new Map<string, { repoId: string; target: string; existingShelfIds: string[] }>());
  const autoApplyAfterSwitchRef = useRef(new Map<string, { repoId: string; target: string; existingShelfIds: string[] }>());
  const autoRestoreAfterShelfRef = useRef(new Map<string, { repoId: string; remainingShelfIds: string[] }>());
  const shelfSwitchBaselineRef = useRef(new Map<string, string[]>());
  const savedShelfSwitchTargetsRef = useRef(new Set<string>());
  const [branchSwitcherOpen, setBranchSwitcherOpen] = useState(false);
  const [switchTargetName, setSwitchTargetName] = useState("");
  const [switchPreflight, setSwitchPreflight] = useState<components["schemas"]["BranchSwitchPreflight"]>();
  const [switchError, setSwitchError] = useState("");
  const [switchBusy, setSwitchBusy] = useState(false);
  const { dialogRef: branchSwitcherRef, onKeyDown: onBranchSwitcherKeyDown } = useDialogFocus<HTMLElement>(() => setBranchSwitcherOpen(false), switchBusy, undefined, branchSwitcherOpen);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>();
  const { shortcuts, setShortcuts } = useShortcutPreferences();
  const [workflowDialog, setWorkflowDialog] = useState<{ repoId: string; targetOid: string; action: WorkflowAction }>();
  const [rebaseDialogOpen, setRebaseDialogOpen] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [remoteBranchDeleteTarget, setRemoteBranchDeleteTarget] = useState<string>();
  const [diffState, setDiffState] = useState<{ key: string; loading: boolean; document?: DiffDocumentResponse; error?: string }>({ key: "", loading: false });
  const [diffRetry, setDiffRetry] = useState(0);
  const [discardSelection, setDiscardSelection] = useState<{ path: string; revision: string; selections: Array<{ hunkIndex: number; rowIndex?: number }> }>();
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
  const pushTargetsByTask = useRef(new Map<string, PushTarget>());
  const [commitActionMenuOpen, setCommitActionMenuOpen] = useState(false);
  const taskRefreshPlannerRef = useRef(new TaskRefreshPlanner());
  const [taskActionId, setTaskActionId] = useState("");
  const [openError, setOpenError] = useState("");
  const [openingRepository, setOpeningRepository] = useState(false);
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
      if (plan.refreshHistory) setHistoryRefreshKey((current) => current + 1);
    },
  });
  const {
    tasks,
    error: tasksError,
    setError: setTasksError,
    refresh: refreshTasks,
    prependTask,
    appendTask,
  } = useTaskCenter(() => apiRef.current);
  const [page, setPage] = useState<Page>("welcome");
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSession>(loadWorkspaceSession);
  const workspaceSessionRef = useRef(workspaceSession);
  workspaceSessionRef.current = workspaceSession;
  const repositoryCacheGenerationRef = useRef(new Map<string, number>());
  const repositoryCacheRequestCountRef = useRef(new Map<string, number>());
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
    getCacheGeneration: repositoryCacheGeneration,
    beginCacheRequest: beginRepositoryCacheRequest,
    finishCacheRequest: finishRepositoryCacheRequest,
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
    getCacheGeneration: repositoryCacheGeneration,
    beginCacheRequest: beginRepositoryCacheRequest,
    finishCacheRequest: finishRepositoryCacheRequest,
  });
  const mode = selectedRepository ? workspaceSession.tabs[selectedRepository.repoId]?.mode || "graph" : "graph";
  const rememberGraphScroll = useWorkspaceGraphScroll(selectedRepository?.repoId, mode, setWorkspaceSession);
  const { selectedCommit, selectCommit } = useWorkspaceCommitSelection(
    selectedRepository?.repoId,
    selectedRepository?.head,
    workspaceSession,
    setWorkspaceSession,
  );
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

  function repositoryCacheGeneration(repoId: string): number {
    return repositoryCacheGenerationRef.current.get(repoId) || 0;
  }

  function beginRepositoryCacheRequest(repoId: string): number {
    repositoryCacheRequestCountRef.current.set(
      repoId,
      (repositoryCacheRequestCountRef.current.get(repoId) || 0) + 1,
    );
    return repositoryCacheGeneration(repoId);
  }

  function finishRepositoryCacheRequest(repoId: string) {
    const remaining = (repositoryCacheRequestCountRef.current.get(repoId) || 1) - 1;
    if (remaining > 0) {
      repositoryCacheRequestCountRef.current.set(repoId, remaining);
    } else {
      repositoryCacheRequestCountRef.current.delete(repoId);
      if (!isRepositoryTabOpen(repoId)) repositoryCacheGenerationRef.current.delete(repoId);
    }
  }

  function invalidateRepositoryUiCache(repoId: string) {
    if (repositoryCacheRequestCountRef.current.has(repoId)) {
      repositoryCacheGenerationRef.current.set(repoId, repositoryCacheGeneration(repoId) + 1);
    } else {
      repositoryCacheGenerationRef.current.delete(repoId);
    }
    clearRepositoryStatus(repoId);
    clearRepositoryRefs(repoId);
  }

  const activeCommitAction: CommitAction = activeTabState?.commitAction || "commit";
  const selectedFilePath = activeTabState?.selectedFilePath;
  const selectedFileScope = activeTabState?.selectedFileScope;
  const selectedDiffCommitOid = activeTabState?.selectedDiffCommitOid;
  const selectedDiffFile = (activeStatus?.files || []).find((file) => file.path === selectedFilePath);
  const activeDiffKey = selectedRepository && selectedFilePath && selectedFileScope
    ? `${selectedRepository.repoId}:${selectedFileScope}:${selectedDiffCommitOid || ""}:${selectedFilePath}`
    : "";
  const statusGroups = changeGroups.map((group) => ({
    ...group,
    files: (activeStatus?.files || []).filter((file) => file.categories.includes(group.category)),
  }));
  const stagedCount = (activeStatus?.files || []).filter((file) => file.categories.includes("staged")).length;
  const hasConflicts = (activeStatus?.files || []).some((file) => file.categories.includes("conflicted"));
  const sensitiveStagedPaths = (activeStatus?.files || []).filter((file) => file.categories.includes("staged") && /(^|\/)(\.env(?:\.|$)|id_(?:rsa|dsa|ed25519)(?:$|\.)|[^/]+\.(?:pem|key|p12|pfx)|credentials(?:\.|$)|secrets?\.)/i.test(file.path)).map((file) => file.path);
  const workingCount = (activeStatus?.files || []).filter((file) => file.categories.some((category) => category === "unstaged" || category === "untracked" || category === "conflicted")).length;
  const hasActiveTasks = tasks.some((task) => task.status === "queued" || task.status === "running");
  const hasActiveRepositoryTask = tasks.some((task) => task.repoId === selectedRepository?.repoId && (task.status === "queued" || task.status === "running"));
  const remoteDisabledReason = !selectedRepository
    ? "Open a repository to manage remotes."
    : !connected
      ? "Connect to the local Git engine to manage remotes."
      : selectedRepository.availability !== "available"
        ? "This repository is unavailable."
        : hasActiveRepositoryTask
          ? "Wait for the current repository task to finish before changing remotes."
          : "";
  const pushDisabledReason = !selectedRepository
    ? "Open a repository to push its current branch."
    : !connected
      ? "Connect to the local Git engine to push."
      : selectedRepository.availability !== "available"
        ? "This repository is unavailable."
        : hasActiveRepositoryTask
          ? "Wait for the current repository task to finish before pushing."
          : "";
  const pullDisabledReason = !selectedRepository
    ? "Open a repository to pull its current branch."
    : !connected
      ? "Connect to the local Git engine to pull."
      : selectedRepository.availability !== "available"
        ? "This repository is unavailable."
        : hasActiveRepositoryTask
          ? "Wait for the current repository task to finish before pulling."
          : "";
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
    retryDiff: () => setDiffRetry((current) => current + 1),
  });
  const commitBusy = commitSubmission.busy;
  const canCommit = Boolean(selectedRepository && activeStatus && stagedCount > 0 && !hasConflicts && commitMessage.trim() && connected && !commitBusy && !hasActiveRepositoryTask && (!commitSelections.length || commitSelectionRepoId === selectedRepository.repoId));
  const {
    busy: stagingBusy,
    stageChanges,
    stageSelectedChanges,
    undoRecentOperation,
    discardSelectedChanges,
  } = useStagingOperations({
    getApi: () => apiRef.current,
    repository: selectedRepository,
    connected,
    hasActiveRepositoryTask,
    hasActiveStagingTask,
    document: diffState.document,
    discardSelection,
    clearDiscardSelection: () => setDiscardSelection(undefined),
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
    refreshHistory: () => setHistoryRefreshKey((current) => current + 1),
  });
  const remoteMutations = useRemoteMutations({
    getApi: () => apiRef.current,
    repoId: selectedRepository?.repoId,
    isRepositoryOpen: isRepositoryTabOpen,
    getCacheGeneration: repositoryCacheGeneration,
    beginCacheRequest: beginRepositoryCacheRequest,
    finishCacheRequest: finishRepositoryCacheRequest,
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
    getApi: () => apiRef.current,
    onTaskAccepted: (task) => {
      appendTask(task);
      setTasksOpen(true);
      setTasksError("");
    },
    onRepositoryOpened: (repository) => {
      setRepositories((current) => [repository, ...current.filter((item) => item.repoId !== repository.repoId)]);
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
    getApi: () => apiRef.current,
    repoId: selectedRepository?.repoId,
    onSelectRepository: (repoId) => {
      if (repoId !== selectedRepository?.repoId) {
        const repository = repositories.find((entry) => entry.repoId === repoId);
        if (repository) activateRepository(repository);
      }
    },
    onTaskAccepted: (task, target, clearTaskError) => {
      pushTargetsByTask.current.set(task.taskId, target);
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

  function openBranchSwitcher() {
    if (!selectedRepository || selectedRepository.availability !== "available") return;
    setSwitchTargetName("");
    setSwitchPreflight(undefined);
    setSwitchError("");
    setBranchSwitcherOpen(true);
    void refreshRepositoryBranches(selectedRepository.repoId);
  }

  async function inspectBranchSwitch(name: string) {
    const api = apiRef.current;
    if (!api || !selectedRepository) return;
    setSwitchTargetName(name);
    setSwitchPreflight(undefined);
    setSwitchError("");
    try {
      setSwitchPreflight(await api.preflightRepositoryBranchSwitch(selectedRepository.repoId, name));
    } catch (error) {
      setSwitchError(error instanceof Error ? error.message : "Could not check this branch switch.");
    }
  }

  async function continueBranchSwitch() {
    const api = apiRef.current;
    const repository = selectedRepository;
    if (!api || !repository || !switchTargetName) return;
    setSwitchBusy(true);
    setSwitchError("");
    try {
      const preflight = await api.preflightRepositoryBranchSwitch(repository.repoId, switchTargetName);
      setSwitchPreflight(preflight);
      if (preflight.potentiallyOverwrittenPaths.length > 0) return;
      const task = await api.switchRepositoryBranch(repository.repoId, switchTargetName);
      prependTask(task);
      setBranchSwitcherOpen(false);
      setTasksOpen(true);
    } catch (error) {
      setSwitchError(error instanceof GitCrestApiError ? error.body.error.message : error instanceof Error ? error.message : "Could not switch branches.");
    } finally {
      setSwitchBusy(false);
    }
  }

  async function continueBranchSwitchAfterShelf(repoId: string, target: string, existingShelfIds: string[]) {
    const api = apiRef.current;
    if (!api) return;
    try {
      const preflight = await api.preflightRepositoryBranchSwitch(repoId, target);
      if (preflight.potentiallyOverwrittenPaths.length > 0) {
        if (selectedRepository?.repoId === repoId) {
          setSwitchTargetName(target);
          setSwitchPreflight(preflight);
          setSwitchError("Some changes remain on paths the target branch updates. Shelve or commit them, then review the switch again.");
          setBranchSwitcherOpen(true);
        } else {
          setTasksError(`The shelf was created, but ${preflight.potentiallyOverwrittenPaths.length} remaining path(s) still overlap ${target}. Reopen that repository to review the switch.`);
        }
        return;
      }
      const task = await api.switchRepositoryBranch(repoId, target);
      autoApplyAfterSwitchRef.current.set(task.taskId, { repoId, target, existingShelfIds });
      prependTask(task);
      setTasksOpen(true);
    } catch (error) {
      setTasksError(error instanceof GitCrestApiError ? error.body.error.message : error instanceof Error ? error.message : "The shelf was created, but GitCrest could not continue the branch switch.");
    }
  }

  async function applyShelvedChangesAfterSwitch(repoId: string, target: string, existingShelfIds: string[]) {
    const api = apiRef.current;
    if (!api) return;
    try {
      const shelves = await api.listRepositoryShelves(repoId);
      const newlyCreated = shelves
        .filter((shelf) => !existingShelfIds.includes(shelf.shelfId))
        .sort((left, right) => left.createdAtMs - right.createdAtMs);
      if (newlyCreated.length === 0) {
        setTasksError("The branch switched, but GitCrest could not identify the newly created shelf. Review the shelf list and restore it manually.");
        setTasksOpen(true);
        return;
      }
      const baselineKey = JSON.stringify([repoId, target]);
      shelfSwitchBaselineRef.current.delete(baselineKey);
      savedShelfSwitchTargetsRef.current.delete(baselineKey);
      await applyNextAutoShelf(repoId, newlyCreated.map((shelf) => shelf.shelfId));
    } catch (error) {
      setTasksError(error instanceof GitCrestApiError ? error.body.error.message : error instanceof Error ? error.message : "The branch switched, but GitCrest could not restore the saved shelf.");
      setTasksOpen(true);
    }
  }

  async function applyNextAutoShelf(repoId: string, shelfIds: string[]) {
    const [shelfId, ...remainingShelfIds] = shelfIds;
    if (!shelfId) return;
    const api = apiRef.current;
    if (!api) return;
    try {
      const preview = await api.preflightRepositoryShelfApply(repoId, shelfId);
      if (!preview.canApplyCleanly && !preview.canApplyWithConflicts) {
        setTasksError("The branch switched, but a saved shelf cannot be restored safely on this branch. Review and apply the remaining shelf manually.");
        setTasksOpen(true);
        return;
      }
      const task = await api.applyRepositoryShelf(repoId, shelfId, {
        expectedHeadOid: preview.expectedHeadOid,
        previewRevision: preview.previewRevision,
      });
      if (task.status === "succeeded") {
        prependTask(task);
        if (remainingShelfIds.length > 0) void applyNextAutoShelf(repoId, remainingShelfIds);
      } else {
        autoRestoreAfterShelfRef.current.set(task.taskId, { repoId, remainingShelfIds });
        prependTask(task);
      }
      setTasksOpen(true);
    } catch (error) {
      setTasksError(error instanceof GitCrestApiError ? error.body.error.message : error instanceof Error ? error.message : "GitCrest could not restore the saved shelf.");
      setTasksOpen(true);
    }
  }

  async function openShelfComposerForBranchSwitch() {
    const repository = selectedRepository;
    const api = apiRef.current;
    if (!repository || !api || !switchTargetName) return;
    setSwitchBusy(true);
    setSwitchError("");
    try {
      const baselineKey = JSON.stringify([repository.repoId, switchTargetName]);
      let existingShelfIds = shelfSwitchBaselineRef.current.get(baselineKey);
      if (!existingShelfIds) {
        const shelves = await api.listRepositoryShelves(repository.repoId);
        existingShelfIds = shelves.map((shelf) => shelf.shelfId);
        shelfSwitchBaselineRef.current.set(baselineKey, existingShelfIds);
      }
      setShelfComposerAfterSwitch({
        repoId: repository.repoId,
        target: switchTargetName,
        existingShelfIds,
      });
      setBranchSwitcherOpen(false);
      setShelfComposerRequest((request) => request + 1);
    } catch (error) {
      setSwitchError(error instanceof Error ? error.message : "Could not prepare the shelf before switching branches.");
    } finally {
      setSwitchBusy(false);
    }
  }

  async function startWorkflowTask(task: TaskSnapshotResponse) {
    prependTask(task);
    setWorkflowDialog(undefined);
    setTasksError("");
    setTasksOpen(true);
  }

  async function openWorkflowConflictWindow(task: TaskSnapshotResponse) {
    if (!task.repoId) return;
    try {
      await requireGitCrestBridge().openConflictWindow({ repoId: task.repoId, taskId: task.taskId });
      setTasksError("");
    } catch (reason) {
      setTasksError(reason instanceof Error ? reason.message : "Could not open the conflict window.");
    }
  }

  async function recoverWorkflowTask(task: TaskSnapshotResponse, _preview: WorkflowRecoveryPreflightResponse, action: "continue" | "skip" | "abort") {
    const api = apiRef.current;
    if (!api || !task.repoId || task.status !== "waitingForInput") return;
    setTaskActionId(task.taskId);
    setTasksError("");
    try {
      const current = await api.preflightRepositoryWorkflowRecovery(task.repoId, task.taskId);
      const allowed = action === "continue" ? current.canContinue : action === "skip" ? current.canSkip : current.canAbort;
      if (!allowed || !current.headOid) throw new Error("Repository state changed. Review the refreshed recovery preview before continuing.");
      await api.recoverRepositoryWorkflow(task.repoId, {
        taskId: task.taskId,
        action,
        expectedOperation: current.operation,
        expectedHeadOid: current.headOid,
        expectedConflictedPaths: current.conflictedPaths,
      });
      await refreshTasks();
    } catch (reason) {
      setTasksError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : "Could not queue workflow recovery.");
    } finally {
      setTaskActionId("");
    }
  }

  async function cancelTask(taskId: string) {
    const api = apiRef.current;
    if (!api) return;
    setTaskActionId(taskId);
    try {
      await api.cancelTask(taskId);
      await refreshTasks();
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "Could not request task cancellation.");
    } finally {
      setTaskActionId("");
    }
  }

  function fetchFromPushDialog() {
    setPushOpen(false);
    void fetchRepository();
  }

  function reviewTaskPush(task: TaskSnapshotResponse) {
    setTasksOpen(false);
    openPushDialog(task.repoId || selectedRepository?.repoId, pushTargetsByTask.current.get(task.taskId), task.operation.startsWith("pushForceWithLease"));
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

  function retryClone(task: TaskSnapshotResponse) {
    cloneSubmission.prepareRetry(task.targetPath);
    setTasksOpen(false);
    cloneSubmission.openDialog();
  }

  function configureTaskCredentials(task: TaskSnapshotResponse) {
    if (task.repoId) {
      const repository = repositories.find((entry) => entry.repoId === task.repoId);
      if (repository) activateRepository(repository);
    }
    setTasksOpen(false);
    setCredentialManagerOpenRequest((current) => current + 1);
  }

  async function copyTaskLogs(task: TaskSnapshotResponse) {
    try {
      await navigator.clipboard.writeText(task.logs.join("\n"));
      setTasksError("");
    } catch {
      setTasksError("Clipboard access is unavailable. Select and copy the task log text.");
    }
  }

  function activateRepository(repository: RepositoryResponse) {
    setOpenError("");
    setWorkspaceSession((current) => ({
      ...current,
      openRepoIds: [...current.openRepoIds.filter((repoId) => repoId !== repository.repoId), repository.repoId],
      activeRepoId: repository.repoId,
      tabs: {
        ...current.tabs,
        [repository.repoId]: current.tabs[repository.repoId]
          ? { ...current.tabs[repository.repoId], selectedCommit: current.tabs[repository.repoId].selectedCommit || repository.head || undefined }
          : { mode: "graph", selectedCommit: repository.head || undefined, graphScrollTop: 0 },
      },
    }));
    setSelectedRepository(repository);
    setPage("workspace");
  }

  function changeWorkspaceMode(nextMode: WorkspaceMode) {
    if (!selectedRepository) {
      setPage("workspace");
      return;
    }
    setWorkspaceSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [selectedRepository.repoId]: {
          ...(current.tabs[selectedRepository.repoId] || { graphScrollTop: 0 }),
          mode: nextMode,
        },
      },
    }));
  }

  function openFileDiff(path: string, scope: "workingTree" | "index") {
    const repoId = selectedRepository?.repoId;
    if (!repoId) return;
    setWorkspaceSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [repoId]: {
          ...(current.tabs[repoId] || { graphScrollTop: 0 }),
          mode: "diff",
          selectedFilePath: path,
          selectedFileScope: scope,
          selectedDiffCommitOid: undefined,
        },
      },
    }));
  }

  function openCommitFileDiff(path: string, oid: string) {
    const repoId = selectedRepository?.repoId;
    if (!repoId || !isFullObjectId(oid)) return;
    setWorkspaceSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [repoId]: {
          ...(current.tabs[repoId] || { graphScrollTop: 0 }),
          mode: "diff",
          selectedCommit: oid,
          selectedFilePath: path,
          selectedFileScope: "commit",
          selectedDiffCommitOid: oid,
        },
      },
    }));
  }

  async function openDiffWindow(path: string, scope: "workingTree" | "index" | "commit", commitOid?: string) {
    const repoId = selectedRepository?.repoId;
    if (!repoId) return;
    try {
      await requireGitCrestBridge().openDiffWindow({ repoId, path, scope, ...(commitOid ? { commitOid } : {}) });
    } catch (error) {
      setDiffState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not open the Diff window." }));
    }
  }

  function closeRepositoryTab(repoId: string) {
    const current = workspaceSessionRef.current;
    const openRepoIds = current.openRepoIds.filter((id) => id !== repoId);
    const closingActive = current.activeRepoId === repoId;
    const nextActiveRepoId = closingActive
      ? openRepoIds[openRepoIds.length - 1]
      : current.activeRepoId;
    const nextRepository = repositories.find((repository) => repository.repoId === nextActiveRepoId);
    const nextSession = { ...current, openRepoIds, activeRepoId: nextActiveRepoId };
    workspaceSessionRef.current = nextSession;
    setWorkspaceSession(nextSession);
    invalidateRepositoryUiCache(repoId);
    if (closingActive) setSelectedRepository(nextRepository);
    if (closingActive && page === "workspace") setPage(nextRepository ? "workspace" : "welcome");
  }

  async function openLocalRepository() {
    setOpenError("");
    try {
      const path = await requireGitCrestBridge().chooseRepository();
      if (!path) return;
      const api = apiRef.current;
      if (!api) throw new Error("The Git engine is still starting. Try again in a moment.");
      setOpeningRepository(true);
      const repository = await api.openRepository(path);
      setRepositories((current) => [repository, ...current.filter((item) => item.repoId !== repository.repoId)]);
      activateRepository(repository);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setOpenError(message || (error instanceof Error ? error.message : "Could not open this repository."));
    } finally {
      setOpeningRepository(false);
    }
  }

  async function initializeLocalRepository() {
    setOpenError("");
    try {
      const path = await requireGitCrestBridge().chooseRepository();
      if (!path) return;
      const api = apiRef.current;
      if (!api) throw new Error("The Git engine is still starting. Try again in a moment.");
      setOpeningRepository(true);
      const repository = await api.initializeRepository(path);
      setRepositories((current) => [repository, ...current.filter((item) => item.repoId !== repository.repoId)]);
      activateRepository(repository);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setOpenError(message || (error instanceof Error ? error.message : "Could not initialize this folder."));
    } finally {
      setOpeningRepository(false);
    }
  }

  async function toggleFavorite(repository: RepositoryResponse) {
    const api = apiRef.current;
    if (!api) return;
    setOpenError("");
    try {
      const updated = await api.setRepositoryFavorite(repository.repoId, !repository.isFavorite);
      setRepositories((current) => current.map((item) => item.repoId === updated.repoId ? updated : item)
        .sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite) || right.lastAccessedAt - left.lastAccessedAt));
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not update this favorite.");
    }
  }

  async function forgetRepository(repository: RepositoryResponse) {
    const api = apiRef.current;
    if (!api) return;
    setOpenError("");
    try {
      await api.forgetRepository(repository.repoId);
      setRepositories((current) => current.filter((item) => item.repoId !== repository.repoId));
      setSelectedRepository((current) => current?.repoId === repository.repoId ? undefined : current);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not remove this recent repository.");
    }
  }

  async function openRecentRepository(repository: RepositoryResponse) {
    const api = apiRef.current;
    if (!api || repository.availability !== "available") return;
    setOpenError("");
    setOpeningRepository(true);
    try {
      const opened = await api.getRepository(repository.repoId);
      setRepositories((current) => [opened, ...current.filter((item) => item.repoId !== opened.repoId)]
        .sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite) || right.lastAccessedAt - left.lastAccessedAt));
      activateRepository(opened);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setOpenError(message || (error instanceof Error ? error.message : "Could not reopen this repository."));
      void refreshRepositories(api).catch(() => undefined);
    } finally {
      setOpeningRepository(false);
    }
  }

  async function refreshRepositories(api: GitCrestApiClient, restoreWorkspace = false) {
    const currentRepositories = await api.listRepositories();
    setRepositories(currentRepositories);
    if (restoreWorkspace) {
      const saved = workspaceSessionRef.current;
      const availableIds = saved.openRepoIds.filter((repoId) =>
        currentRepositories.some((repository) => repository.repoId === repoId && repository.availability === "available"));
      const activeRepoId = saved.activeRepoId && availableIds.includes(saved.activeRepoId)
        ? saved.activeRepoId
        : availableIds[availableIds.length - 1];
      const activeRepository = currentRepositories.find((repository) => repository.repoId === activeRepoId);
      setWorkspaceSession({ ...saved, openRepoIds: availableIds, activeRepoId });
      setSelectedRepository(activeRepository);
      setPage(activeRepository ? "workspace" : "welcome");
    } else {
      setSelectedRepository((current) => currentRepositories.find((repository) => repository.repoId === current?.repoId));
    }
  }

  useEffect(() => {
    if (mode !== "diff" || !selectedRepository || !selectedFilePath || !selectedFileScope) {
      setDiffState({ key: "", loading: false });
      return;
    }
    const api = apiRef.current;
    if (!api) return;
    let active = true;
    const key = `${selectedRepository.repoId}:${selectedFileScope}:${selectedDiffCommitOid || ""}:${selectedFilePath}`;
    setDiffState({ key, loading: true });
    const request = selectedFileScope === "commit" && selectedDiffCommitOid
      ? api.getRepositoryCommitDiff(selectedRepository.repoId, selectedDiffCommitOid, selectedFilePath)
      : selectedFileScope === "workingTree" || selectedFileScope === "index"
        ? api.getFileDiff(selectedRepository.repoId, selectedFilePath, selectedFileScope)
        : Promise.reject(new Error("The selected commit diff is unavailable."));
    request
      .then((document) => { if (active) setDiffState({ key, loading: false, document }); })
      .catch((error: unknown) => {
        const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
        if (active) setDiffState({ key, loading: false, error: message || (error instanceof Error ? error.message : "Could not read this file diff.") });
      });
    return () => { active = false; };
  }, [mode, selectedRepository?.repoId, selectedFilePath, selectedFileScope, selectedDiffCommitOid, diffRetry]);

  useEffect(() => {
    for (const task of tasks) void cloneSubmission.openClonedRepository(task);
  }, [tasks]);

  useEffect(() => {
    for (const task of tasks) {
      if (task.repoId && taskRefreshPlannerRef.current.shouldRefreshWorkflowInput(task)) {
        void refreshRepositoryStatus(task.repoId);
      }
      const autoSwitch = autoSwitchAfterShelfRef.current.get(task.taskId);
      if (autoSwitch && !["queued", "running"].includes(task.status)) {
        autoSwitchAfterShelfRef.current.delete(task.taskId);
        if (task.status === "succeeded") void continueBranchSwitchAfterShelf(autoSwitch.repoId, autoSwitch.target, autoSwitch.existingShelfIds);
      }
      const autoApply = autoApplyAfterSwitchRef.current.get(task.taskId);
      if (autoApply && !["queued", "running"].includes(task.status)) {
        autoApplyAfterSwitchRef.current.delete(task.taskId);
        if (task.status === "succeeded") void applyShelvedChangesAfterSwitch(autoApply.repoId, autoApply.target, autoApply.existingShelfIds);
      }
      const pendingShelfRestore = autoRestoreAfterShelfRef.current.get(task.taskId);
      if (pendingShelfRestore && task.status === "succeeded") {
        autoRestoreAfterShelfRef.current.delete(task.taskId);
        if (pendingShelfRestore.remainingShelfIds.length > 0) {
          void applyNextAutoShelf(pendingShelfRestore.repoId, pendingShelfRestore.remainingShelfIds);
        }
      } else if (pendingShelfRestore && ["failed", "cancelled"].includes(task.status)) {
        autoRestoreAfterShelfRef.current.delete(task.taskId);
        if (pendingShelfRestore.remainingShelfIds.length > 0) {
          setTasksError("A shelf restore did not finish. The remaining shelves are still saved and can be applied manually.");
          setTasksOpen(true);
        }
      }

      const refreshPlan = taskRefreshPlannerRef.current.takeTerminalTaskPlan(task);
      if (!refreshPlan) continue;
      let commitIntent: { action: CommitAction; target?: PushTarget; forceWithLease: boolean } | undefined;
      if (refreshPlan.kind === "commit") {
        const commitContext = commitSubmission.takeTaskContext(task.taskId);
        commitIntent = commitContext?.intent;
        if (task.status === "succeeded" && commitContext?.message === commitMessage) setCommitMessage("");
        if (task.status === "succeeded" && commitContext?.selections === JSON.stringify(commitSelections)) {
          setCommitSelections([]);
        }
      }
      if (["branch", "remote", "pull", "workflow"].includes(refreshPlan.kind) && !refreshPlan.repoId) continue;
      if (refreshPlan.repoId && refreshPlan.refreshRepository) {
        const api = apiRef.current;
        if (api) {
          void api.getRepository(refreshPlan.repoId).then((repository) => {
            setRepositories((current) => current.map((entry) => entry.repoId === repository.repoId ? repository : entry));
            setSelectedRepository((current) => current?.repoId === repository.repoId ? repository : current);
          }).catch((error) => {
            if (refreshPlan.reportRepositoryRefreshError) {
              setTasksError(error instanceof Error ? error.message : "Could not refresh repository metadata after commit.");
            }
          });
        }
      }
      if (refreshPlan.repoId && refreshPlan.refreshStatus) void refreshRepositoryStatus(refreshPlan.repoId);
      if (refreshPlan.repoId && refreshPlan.refreshBranches) void refreshRepositoryBranches(refreshPlan.repoId);
      if (refreshPlan.repoId && refreshPlan.refreshRemotes) void refreshRepositoryRemotes(refreshPlan.repoId);
      if (refreshPlan.refreshHistory) setHistoryRefreshKey((current) => current + 1);
      if (refreshPlan.kind === "commit" && task.repoId && task.status === "succeeded" && commitIntent && commitIntent.action !== "commit") {
        void continueCommitPush(task.repoId, commitIntent);
      }
    }
  }, [tasks]);

  useEffect(() => {
    saveWorkspaceSession(workspaceSession);
  }, [workspaceSession]);

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
    repositoryHeadIsFull: isFullObjectId(selectedRepository?.head),
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
    openRepository: () => { void openLocalRepository(); },
    cloneRepository: () => cloneSubmission.openDialog(),
    initializeRepository: () => { void initializeLocalRepository(); },
    stageAll: () => { void stageChanges("stageAll"); },
    undoRecentOperation: () => { void undoRecentOperation(); },
    fetch: () => { void fetchRepository(); },
    push: openPushDialog,
    refreshStatus: (repoId) => { void refreshRepositoryStatus(repoId, true); },
    openDiff: () => changeWorkspaceMode("diff"),
    searchCommits: (repoId) => {
      changeWorkspaceMode("graph");
      setHistorySearchFocusRequest((request) => ({ repoId, sequence: (request?.sequence || 0) + 1 }));
    },
    openShelfComposer: () => setShelfComposerRequest((request) => request + 1),
    cherryPick: (repoId, targetOid) => setWorkflowDialog({ repoId, targetOid, action: "cherryPick" }),
    createTag: (repoId, oid) => {
      changeWorkspaceMode("graph");
      setTagEditorRequest((request) => ({ repoId, oid, sequence: (request?.sequence || 0) + 1 }));
    },
    openSettings: () => setSettingsOpen(true),
    commit: () => { void commitChanges("commit"); },
    commitAndPush: () => { void commitChanges("commitAndPush"); },
    pull: openPullDialog,
    rebase: () => setRebaseDialogOpen(true),
    openBranchSwitcher,
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

  const commands = [
    { id: "welcome", label: "Go to Welcome", detail: "Return to recent repositories and quick actions", available: true, run: () => setPage("welcome") },
    { id: "workspace", label: "Go to Workspace", detail: "Open the Changes, Graph, and Commit workspace", available: true, run: () => setPage("workspace") },
    { id: "theme", label: "Cycle color theme", detail: `Current: ${theme}; next: ${THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]}`, available: true, run: nextTheme },
    { id: "open", label: "Open local repository", detail: "Choose a local Git repository folder", available: true, run: () => { void openLocalRepository(); } },
    { id: "fetch", label: "Fetch from remotes", detail: "Start a cancellable fetch task", available: Boolean(selectedRepository), run: () => { void fetchRepository(); } },
    { id: "pull", label: "Pull current branch", detail: "Review worktree state and choose merge or rebase", available: Boolean(selectedRepository), run: () => openPullDialog() },
    { id: "rebase", label: "Interactive rebase", detail: `Review, reorder, and edit the current branch commit sequence (${displayShortcut(shortcuts.rebase, isMacPlatform)})`, available: Boolean(selectedRepository && activeBranches && connected), run: () => setRebaseDialogOpen(true) },
    { id: "reset", label: "Reset current branch", detail: "Review commit and file impact before moving HEAD", available: Boolean(selectedRepository && activeBranches && connected), run: () => setResetDialogOpen(true) },
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
                <button type="button" role="tab" aria-selected={active} title={repository.path} onClick={() => { if (!active) void openRecentRepository(repository); }}>
                  {repositoryName(repository.path)}
                </button>
                <button type="button" className="closeRepositoryTab" aria-label={`Close ${repositoryName(repository.path)} tab`} title="Close tab" onClick={() => closeRepositoryTab(repoId)}>×</button>
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
          openingRepository={openingRepository}
          connected={connected}
          shortcuts={shortcuts}
          isMacPlatform={isMacPlatform}
          openError={openError}
          version={version}
          onOpenLocalRepository={() => void openLocalRepository()}
          onCloneRepository={() => cloneSubmission.openDialog()}
          onNavigateWorkspace={() => setPage("workspace")}
          onInitializeRepository={() => void initializeLocalRepository()}
          onOpenRepository={(repository) => void openRecentRepository(repository)}
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
          onOpenBranchSwitcher={openBranchSwitcher}
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
              credentialManagerOpenRequest={credentialManagerOpenRequest}
              historyRefreshKey={historyRefreshKey}
              shelfComposerRequest={shelfComposerRequest}
              shelfComposerAfterSwitch={shelfComposerAfterSwitch}
              connected={connected}
              connecting={connecting}
              hasActiveRepositoryTask={hasActiveRepositoryTask}
              shortcuts={shortcuts}
              isMacPlatform={isMacPlatform}
              onStageChanges={(action, path) => void stageChanges(action, path)}
              onRefreshRepositoryStatus={(repoId, force) => void refreshRepositoryStatus(repoId, force)}
              onRefreshRepositoryBranches={(repoId) => void refreshRepositoryBranches(repoId)}
              onOpenFileDiff={openFileDiff}
              onDeleteRemoteBranch={setRemoteBranchDeleteTarget}
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
                  if (switchTarget) {
                    const repoId = shelfComposerAfterSwitch?.repoId;
                    if (repoId) {
                      autoSwitchAfterShelfRef.current.set(task.taskId, {
                        repoId,
                        target: switchTarget.switchTarget,
                        existingShelfIds: switchTarget.existingShelfIds,
                      });
                      savedShelfSwitchTargetsRef.current.add(JSON.stringify([repoId, switchTarget.switchTarget]));
                    }
                    setShelfComposerAfterSwitch(undefined);
                  }
                }
                void refreshTasks();
              }}
              onShelfComposerClosed={() => {
                if (shelfComposerAfterSwitch) {
                  const baselineKey = JSON.stringify([shelfComposerAfterSwitch.repoId, shelfComposerAfterSwitch.target]);
                  if (!savedShelfSwitchTargetsRef.current.has(baselineKey)) shelfSwitchBaselineRef.current.delete(baselineKey);
                }
                setShelfComposerAfterSwitch(undefined);
              }}
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
                historyRefreshKey={historyRefreshKey}
                historySearchFocusRequest={historySearchFocusRequest}
                graphViewportRef={graphViewportRef}
                openingRepository={openingRepository}
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
                onFocusSearchHandled={(sequence) => setHistorySearchFocusRequest((request) => request?.sequence === sequence ? undefined : request)}
                onGraphScrollPosition={rememberGraphScroll}
                onSelectCommit={selectCommit}
                onOpenRepository={() => void openLocalRepository()}
                onRetryDiff={() => setDiffRetry((current) => current + 1)}
                onStageSelection={stageSelectedChanges}
                onDiscardSelection={(document, selections) => { setTasksError(""); setDiscardSelection({ path: document.path, revision: document.revision, selections }); }}
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
              openTagRequest={tagEditorRequest}
              shortcuts={shortcuts}
              isMacPlatform={isMacPlatform}
              onOpenFile={openCommitFileDiff}
              onOpenDiffWindow={(path, oid) => void openDiffWindow(path, "commit", oid)}
              onTagRequestHandled={(sequence) => setTagEditorRequest((request) => request?.sequence === sequence ? undefined : request)}
              onWorkflow={(action, oid) => { if (selectedRepository) setWorkflowDialog({ repoId: selectedRepository.repoId, targetOid: oid, action }); }}
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

      {branchSwitcherOpen && selectedRepository && (
        <div className="paletteBackdrop branchSwitcherBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !switchBusy) setBranchSwitcherOpen(false); }}>
          <section ref={branchSwitcherRef} className="branchSwitcherDialog" role="dialog" aria-modal="true" aria-labelledby="branch-switcher-title" onKeyDown={onBranchSwitcherKeyDown}>
            <div className="dialogHeading"><div><span className="sectionEyebrow">BRANCHES · {repositoryName(selectedRepository.path)}</span><h2 id="branch-switcher-title">Switch branch</h2></div><button className="dialogClose" type="button" aria-label="Close branch switcher" disabled={switchBusy} onClick={() => setBranchSwitcherOpen(false)}>×</button></div>
            <p className="branchSwitcherCurrent">Current branch: <strong>{selectedRepository.detached ? `Detached · ${selectedRepository.head?.slice(0, 7)}` : selectedRepository.branch || "Unborn branch"}</strong></p>
            {switchTargetName ? (
              <div className="branchSwitchDetails">
                <button className="textButton" type="button" disabled={switchBusy} onClick={() => { setSwitchTargetName(""); setSwitchPreflight(undefined); setSwitchError(""); }}>← Choose another branch</button>
                <h3>{switchTargetName}</h3>
                {switchBusy && !switchPreflight && <p role="status">Checking the working tree…</p>}
                {switchError && <p className="dialogError" role="alert">{switchError}</p>}
                {switchPreflight?.isClean && <p className="branchCleanNotice" role="status">The working tree is clean. GitCrest can switch to this branch.</p>}
                {switchPreflight && !switchPreflight.isClean && <>
                  <p className="branchDirtyNotice" role="alert">Commit or shelve these changes before switching.</p>
                  <div className="branchDirtyFiles" aria-label="Uncommitted files">
                    {switchPreflight.dirtyFiles.map((path) => <div className="branchDirtyFile" key={path}><span aria-hidden="true">•</span><span>{path}</span>{switchPreflight.potentiallyOverwrittenPaths.includes(path) && <strong>May be overwritten</strong>}</div>)}
                  </div>
                  <div className="branchSwitchOptions">
                    <button className="secondaryButton" type="button" onClick={() => { setBranchSwitcherOpen(false); requestAnimationFrame(() => document.getElementById("commit-message")?.focus()); }}>Commit changes</button>
                    <button className="secondaryButton" type="button" disabled={switchBusy || !connected || hasActiveRepositoryTask} aria-keyshortcuts={ariaShortcut(shortcuts.shelve, isMacPlatform)} title={`Shelve selected changes, then switch to ${switchTargetName} (${displayShortcut(shortcuts.shelve, isMacPlatform)})`} onClick={() => void openShelfComposerForBranchSwitch()}>Shelve &amp; switch</button>
                    <button className="secondaryButton" type="button" disabled={switchBusy || switchPreflight.potentiallyOverwrittenPaths.length > 0} title={switchPreflight.potentiallyOverwrittenPaths.length > 0 ? "The target branch changes one or more listed paths" : "Switch branches while keeping these non-overlapping changes"} onClick={() => void continueBranchSwitch()}>Continue</button>
                  </div>
                </>}
              </div>
            ) : (
              <div className="branchSwitchChoices">
                <h3>Local branches</h3>
                {!activeBranches && activeBranchesLoading && <p role="status">Loading branches…</p>}
                {activeBranchError && <p className="dialogError" role="alert">{activeBranchError}</p>}
                {activeBranches && orderedBranches.filter((branch) => branch.kind === "local" && !branch.isCurrent).length === 0 && <p className="navEmpty">There are no other local branches.</p>}
                {orderedBranches.filter((branch) => branch.kind === "local" && !branch.isCurrent).map((branch) => <button className="branchChoice" type="button" key={branch.fullName} disabled={switchBusy} onClick={() => { setSwitchBusy(true); void inspectBranchSwitch(branch.name).finally(() => setSwitchBusy(false)); }}><span className="branchItemGlyph" aria-hidden="true">⑂</span><span>{branch.name}</span>{branch.isFavorite && <span className="branchFavoriteMark" aria-label="Favorite">★</span>}<span className="actionArrow" aria-hidden="true">→</span></button>)}
                {orderedBranches.some((branch) => branch.kind === "remote") && <p className="branchRemoteNote">Remote branches are shown in navigation. Check out a local tracking branch before switching to a remote branch.</p>}
              </div>
            )}
            <div className="dialogActions"><button className="secondaryButton" type="button" disabled={switchBusy} onClick={() => setBranchSwitcherOpen(false)}>Cancel</button>{switchTargetName && switchPreflight?.isClean && <button className="primaryButton" type="button" disabled={switchBusy} onClick={() => void continueBranchSwitch()}>{switchBusy ? "Switching…" : `Switch to ${switchTargetName}`}</button>}</div>
            <div className="branchSwitcherHint"><kbd>{displayShortcut(shortcuts.branchSwitcher, isMacPlatform)}</kbd> opens this switcher <span>Esc closes</span></div>
          </section>
        </div>
      )}

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
          <div className="paletteContext">{page === "welcome" ? "WELCOME" : selectedRepository ? `WORKSPACE · ${repositoryName(selectedRepository.path).toUpperCase()}` : "WORKSPACE · NO REPOSITORY"}</div>
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
      {tasksOpen && <TaskCenter api={apiRef.current} tasks={tasks} error={tasksError} actionId={taskActionId} onClose={() => setTasksOpen(false)} onRefresh={() => void refreshTasks()} onCancel={(taskId) => void cancelTask(taskId)} onCopy={(task) => void copyTaskLogs(task)} onRetryClone={retryClone} onConfigureCredentials={configureTaskCredentials} onReviewPush={reviewTaskPush} onRecoverWorkflow={(task, preview, action) => void recoverWorkflowTask(task, preview, action)} onOpenConflictWindow={(task) => void openWorkflowConflictWindow(task)} />}
      {settingsOpen && apiRef.current && <SettingsDialog api={apiRef.current} repoId={selectedRepository?.repoId} onClose={() => setSettingsOpen(false)} shortcuts={shortcuts} onShortcutsChange={setShortcuts} updateStatus={updateStatus} onCheckForUpdates={async () => {
        const check = getGitCrestBridge()?.checkForUpdates;
        if (!check) return;
        try { setUpdateStatus(await check()); }
        catch { setUpdateStatus({ state: "error", message: "The update check failed. Try again later." }); }
      }} onInstallUpdate={() => {
        const install = getGitCrestBridge()?.installUpdate;
        if (install) void install().catch(() => setUpdateStatus({ state: "error", message: "The update could not be installed." }));
      }} />}
      {discardSelection && <DiscardChangesDialog path={discardSelection.path} selectionCount={discardSelection.selections.length} disabled={stagingBusy || hasActiveStagingTask || hasActiveRepositoryTask} error={tasksError || undefined} onCancel={() => setDiscardSelection(undefined)} onConfirm={() => void discardSelectedChanges()} />}
      {workflowDialog && apiRef.current && <WorkflowDialog api={apiRef.current} repoId={workflowDialog.repoId} targetOid={workflowDialog.targetOid} action={workflowDialog.action} onClose={() => setWorkflowDialog(undefined)} onStarted={(task) => void startWorkflowTask(task)} />}
      {rebaseDialogOpen && selectedRepository && apiRef.current && <RebaseDialog api={apiRef.current} repoId={selectedRepository.repoId} branches={activeBranches} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setRebaseDialogOpen(false)} onStarted={(task) => { setRebaseDialogOpen(false); void startWorkflowTask(task); }} />}
      {resetDialogOpen && selectedRepository && apiRef.current && <ResetDialog api={apiRef.current} repoId={selectedRepository.repoId} branches={activeBranches} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setResetDialogOpen(false)} onStarted={(task) => { setResetDialogOpen(false); void startWorkflowTask(task); }} />}
      {remoteBranchDeleteTarget && selectedRepository && apiRef.current && <RemoteBranchDeleteDialog api={apiRef.current} repoId={selectedRepository.repoId} branchRef={remoteBranchDeleteTarget} remotes={activeRemotes} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClose={() => setRemoteBranchDeleteTarget(undefined)} onStarted={(task) => { setRemoteBranchDeleteTarget(undefined); void startWorkflowTask(task); }} />}
      {cloneSubmission.dialogOpen && <CloneDialog initialRemoteUrl={cloneSubmission.draft.remoteUrl} initialDirectoryName={cloneSubmission.draft.directoryName} parentPath={cloneSubmission.draft.parentPath} error={cloneSubmission.error} busy={cloneSubmission.busy} api={apiRef.current} onChooseParent={() => requireGitCrestBridge().chooseCloneParent()} onClose={cloneSubmission.closeDialog} onSubmit={(remoteUrl, parentPath, directoryName) => void cloneSubmission.submit(remoteUrl, parentPath, directoryName)} />}
      </Suspense>
    </main>
  );
}

export default App;
