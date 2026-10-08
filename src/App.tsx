import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { GitCrestApiClient, GitCrestApiError, type BranchSnapshotResponse, type CommitRequest, type DiffDocumentResponse, type RemoteSnapshotResponse, type RepositoryResponse, type StagingPatchRequest, type StagingRequest, type StatusSnapshotResponse, type TaskSnapshotResponse, type WorkflowRecoveryPreflightResponse } from "./api/client";
import { CommitDetails, CommitGraph } from "./features/history/CommitGraph";
import { TaskCenter } from "./features/tasks/TaskCenter";
import { WorkflowDialog, type WorkflowAction } from "./features/workflows/WorkflowDialog";
import { CloneDialog } from "./features/cloning/CloneDialog";
import { RemoteManager } from "./features/remotes/RemoteManager";
import { PushDialog } from "./features/remotes/PushDialog";
import { PullDialog } from "./features/remotes/PullDialog";
import { ShelfCenter } from "./features/shelves/ShelfCenter";
import { PushTargetDialog, type PushTarget } from "./features/remotes/PushTargetDialog";
import { SplitDiff } from "./features/diff/SplitDiff";
import type { components } from "./api/schema";
import "./App.css";

type Theme = "system" | "light" | "dark";
type Page = "welcome" | "workspace";
type WorkspaceMode = "graph" | "diff";
type CommitAction = "commit" | "commitAndPush" | "commitAndPushTo" | "commitAndPushForce";
type CommitIntent = { action: CommitAction; target?: PushTarget; forceWithLease: boolean };
type RepositoryTabState = { mode: WorkspaceMode; selectedCommit?: string; selectedFilePath?: string; selectedFileScope?: "workingTree" | "index" | "commit"; selectedDiffCommitOid?: string; graphScrollTop: number; commitAction?: CommitAction };
type WorkspaceSession = { openRepoIds: string[]; activeRepoId?: string; tabs: Record<string, RepositoryTabState> };

const WORKSPACE_SESSION_KEY = "gitcrest-workspace-session-v1";

function readWorkspaceSession(): WorkspaceSession {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_KEY) || "null");
    if (!value || typeof value !== "object") return { openRepoIds: [], tabs: {} };
    const session = value as Partial<WorkspaceSession>;
    const openRepoIds = Array.isArray(session.openRepoIds)
      ? [...new Set(session.openRepoIds.filter((id): id is string => typeof id === "string"))]
      : [];
    const tabs: WorkspaceSession["tabs"] = {};
    if (session.tabs && typeof session.tabs === "object") {
      for (const [repoId, state] of Object.entries(session.tabs)) {
        if (!state || typeof state !== "object") continue;
        const candidate = state as Partial<RepositoryTabState>;
        tabs[repoId] = {
          mode: candidate.mode === "diff" ? "diff" : "graph",
          ...(typeof candidate.selectedCommit === "string" ? { selectedCommit: candidate.selectedCommit } : {}),
          ...(typeof candidate.selectedFilePath === "string" ? { selectedFilePath: candidate.selectedFilePath } : {}),
          ...(candidate.selectedFileScope === "workingTree" || candidate.selectedFileScope === "index" || candidate.selectedFileScope === "commit" ? { selectedFileScope: candidate.selectedFileScope } : {}),
          ...(typeof candidate.selectedDiffCommitOid === "string" ? { selectedDiffCommitOid: candidate.selectedDiffCommitOid } : {}),
          ...(candidate.commitAction === "commit" || candidate.commitAction === "commitAndPush" || candidate.commitAction === "commitAndPushTo" || candidate.commitAction === "commitAndPushForce" ? { commitAction: candidate.commitAction } : {}),
          graphScrollTop: typeof candidate.graphScrollTop === "number" && Number.isFinite(candidate.graphScrollTop)
            ? Math.max(0, candidate.graphScrollTop)
            : 0,
        };
      }
    }
    return {
      openRepoIds,
      ...(typeof session.activeRepoId === "string" ? { activeRepoId: session.activeRepoId } : {}),
      tabs,
    };
  } catch {
    return { openRepoIds: [], tabs: {} };
  }
}

const themeCycle: Theme[] = ["system", "light", "dark"];
const changeGroups = [
  { category: "staged", label: "Staged" },
  { category: "unstaged", label: "Unstaged" },
  { category: "untracked", label: "Untracked" },
  { category: "conflicted", label: "Conflicted" },
  { category: "ignored", label: "Ignored" },
] as const;

function changeCode(kind: StatusSnapshotResponse["files"][number]["kind"]): string {
  return ({ modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", typeChanged: "T", untracked: "?", ignored: "!", conflicted: "U" })[kind];
}

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  } catch {
    return fallback;
  }
}

function repositoryName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function isFullObjectId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function ResizeSeparator({
  orientation,
  edge,
  value,
  min,
  max,
  label,
  onResize,
}: {
  orientation: "vertical" | "horizontal";
  edge: "left" | "right" | "bottom";
  value: number;
  min: number;
  max: number;
  label: string;
  onResize: (value: number) => void;
}) {
  const drag = useRef<{ pointerId: number; coordinate: number; value: number }>();

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      coordinate: orientation === "vertical" ? event.clientX : event.clientY,
      value,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const sign = edge === "left" ? 1 : -1;
    const delta = orientation === "horizontal"
      ? (event.clientY - drag.current.coordinate) * (edge === "bottom" ? -1 : 1)
      : (event.clientX - drag.current.coordinate) * sign;
    onResize(Math.max(min, Math.min(max, drag.current.value + delta)));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const increaseKeys = orientation === "vertical" ? ["ArrowRight", "ArrowUp"] : ["ArrowUp", "ArrowRight"];
    const decreaseKeys = orientation === "vertical" ? ["ArrowLeft", "ArrowDown"] : ["ArrowDown", "ArrowLeft"];
    if (increaseKeys.includes(event.key)) {
      event.preventDefault();
      onResize(Math.min(max, value + 16));
    } else if (decreaseKeys.includes(event.key)) {
      event.preventDefault();
      onResize(Math.max(min, value - 16));
    } else if (event.key === "Home") {
      event.preventDefault();
      onResize(min);
    } else if (event.key === "End") {
      event.preventDefault();
      onResize(max);
    }
  }

  return (
    <div
      className={`resizeSeparator ${orientation}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => { drag.current = undefined; }}
      onPointerCancel={() => { drag.current = undefined; }}
      onKeyDown={onKeyDown}
    />
  );
}

function App() {
  const commandKey = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";
  const [status, setStatus] = useState("Starting local GitCrest core...");
  const [version, setVersion] = useState("");
  const [repositories, setRepositories] = useState<RepositoryResponse[]>([]);
  const [selectedRepository, setSelectedRepository] = useState<RepositoryResponse>();
  const [statusSnapshots, setStatusSnapshots] = useState<Record<string, StatusSnapshotResponse>>({});
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const [statusLoadingByRepo, setStatusLoadingByRepo] = useState<Record<string, boolean>>({});
  const [branchSnapshots, setBranchSnapshots] = useState<Record<string, BranchSnapshotResponse>>({});
  const [branchErrors, setBranchErrors] = useState<Record<string, string>>({});
  const [branchLoadingByRepo, setBranchLoadingByRepo] = useState<Record<string, boolean>>({});
  const [remoteSnapshots, setRemoteSnapshots] = useState<Record<string, RemoteSnapshotResponse>>({});
  const [remoteErrors, setRemoteErrors] = useState<Record<string, string>>({});
  const [remoteLoadingByRepo, setRemoteLoadingByRepo] = useState<Record<string, boolean>>({});
  const [remoteActionBusy, setRemoteActionBusy] = useState(false);
  const [credentialManagerOpenRequest, setCredentialManagerOpenRequest] = useState(0);
  const [pushOpen, setPushOpen] = useState(false);
  const [pushPreflight, setPushPreflight] = useState<components["schemas"]["PushPreflight"]>();
  const [pushLoading, setPushLoading] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState("");
  const [pushForceOnly, setPushForceOnly] = useState(false);
  const [pushTarget, setPushTarget] = useState<PushTarget>();
  const [pushTargetDialogOpen, setPushTargetDialogOpen] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);
  const [pullPreflight, setPullPreflight] = useState<components["schemas"]["PullPreflight"]>();
  const [pullLoading, setPullLoading] = useState(false);
  const [pullBusy, setPullBusy] = useState(false);
  const [pullError, setPullError] = useState("");
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [shelfComposerRequest, setShelfComposerRequest] = useState(0);
  const [branchSwitcherOpen, setBranchSwitcherOpen] = useState(false);
  const [switchTargetName, setSwitchTargetName] = useState("");
  const [switchPreflight, setSwitchPreflight] = useState<components["schemas"]["BranchSwitchPreflight"]>();
  const [switchError, setSwitchError] = useState("");
  const [switchBusy, setSwitchBusy] = useState(false);
  const [tasks, setTasks] = useState<TaskSnapshotResponse[]>([]);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [workflowDialog, setWorkflowDialog] = useState<{ repoId: string; targetOid: string; action: WorkflowAction }>();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneError, setCloneError] = useState("");
  const [cloneDraft, setCloneDraft] = useState({ remoteUrl: "", parentPath: "", directoryName: "" });
  const [diffState, setDiffState] = useState<{ key: string; loading: boolean; document?: DiffDocumentResponse; error?: string }>({ key: "", loading: false });
  const [diffRetry, setDiffRetry] = useState(0);
  const openedCloneTasks = useRef(new Set<string>());
  const cloneTaskIds = useRef(new Set<string>());
  const [tasksError, setTasksError] = useState("");
  const [stagingBusy, setStagingBusy] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitTemplate, setCommitTemplate] = useState("plain");
  const [amendCommit, setAmendCommit] = useState(false);
  const [signOffCommit, setSignOffCommit] = useState(false);
  const [signCommit, setSignCommit] = useState(false);
  const [commitSelections, setCommitSelections] = useState<NonNullable<CommitRequest["selections"]>>([]);
  const [commitSelectionRepoId, setCommitSelectionRepoId] = useState<string>();
  const commitSelectionsByTask = useRef(new Map<string, string>());
  const commitMessagesByTask = useRef(new Map<string, string>());
  const commitIntentsByTask = useRef(new Map<string, CommitIntent>());
  const pushTargetsByTask = useRef(new Map<string, PushTarget>());
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitActionMenuOpen, setCommitActionMenuOpen] = useState(false);
  const refreshedStagingTasks = useRef(new Set<string>());
  const refreshedCommitTasks = useRef(new Set<string>());
  const refreshedBranchTasks = useRef(new Set<string>());
  const refreshedRemoteTasks = useRef(new Set<string>());
  const refreshedFetchTasks = useRef(new Set<string>());
  const refreshedPushTasks = useRef(new Set<string>());
  const refreshedPullTasks = useRef(new Set<string>());
  const refreshedWorkflowTasks = useRef(new Set<string>());
  const refreshedWaitingWorkflowTasks = useRef(new Set<string>());
  const [taskActionId, setTaskActionId] = useState("");
  const [openError, setOpenError] = useState("");
  const [openingRepository, setOpeningRepository] = useState(false);
  const apiRef = useRef<GitCrestApiClient>();
  const [page, setPage] = useState<Page>("welcome");
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSession>(readWorkspaceSession);
  const workspaceSessionRef = useRef(workspaceSession);
  workspaceSessionRef.current = workspaceSession;
  const mode = selectedRepository ? workspaceSession.tabs[selectedRepository.repoId]?.mode || "graph" : "graph";
  const selectedCommit = selectedRepository
    ? workspaceSession.tabs[selectedRepository.repoId]?.selectedCommit || selectedRepository.head || undefined
    : undefined;
  const graphViewportRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = window.localStorage.getItem("gitcrest-theme");
      return stored === "light" || stored === "dark" ? stored : "system";
    } catch {
      return "system";
    }
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber("gitcrest-sidebar-width", 236, 190, 340));
  const [detailsWidth, setDetailsWidth] = useState(() => readStoredNumber("gitcrest-details-width", 284, 220, 420));
  const [workbenchHeight, setWorkbenchHeight] = useState(() => readStoredNumber("gitcrest-workbench-height", 204, 144, 360));
  const [layoutLoadedFor, setLayoutLoadedFor] = useState<string>();
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
  const canCommit = Boolean(selectedRepository && activeStatus && stagedCount > 0 && !hasConflicts && commitMessage.trim() && connected && !commitBusy && !hasActiveRepositoryTask && (!commitSelections.length || commitSelectionRepoId === selectedRepository.repoId));
  const commitActionLabel = amendCommit
    ? activeCommitAction === "commit" ? "Amend" : activeCommitAction === "commitAndPushTo" ? "Amend and Push to…" : "Amend and Push"
    : activeCommitAction === "commit" ? "Commit" : activeCommitAction === "commitAndPushTo" ? "Commit and Push to…" : activeCommitAction === "commitAndPushForce" ? "Commit and Push (force-with-lease)" : "Commit and Push";
  const commitActionIsDanger = activeCommitAction === "commitAndPushForce" || (amendCommit && activeCommitAction !== "commit");
  const hasActiveStagingTask = tasks.some((task) => (task.operation.startsWith("stage") || task.operation.startsWith("unstage")) && (task.status === "queued" || task.status === "running"));
  const hasActiveTasksRef = useRef(false);
  hasActiveTasksRef.current = hasActiveTasks;

  async function refreshRepositoryStatus(repoId: string) {
    const api = apiRef.current;
    if (!api) return;
    setStatusLoadingByRepo((current) => ({ ...current, [repoId]: true }));
    setStatusErrors((current) => ({ ...current, [repoId]: "" }));
    try {
      const snapshot = await api.getRepositoryStatus(repoId);
      setStatusSnapshots((current) => ({ ...current, [repoId]: snapshot }));
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setStatusErrors((current) => ({ ...current, [repoId]: message || (error instanceof Error ? error.message : "Could not refresh repository status.") }));
    } finally {
      setStatusLoadingByRepo((current) => ({ ...current, [repoId]: false }));
    }
  }

  async function refreshRepositoryBranches(repoId: string) {
    const api = apiRef.current;
    if (!api) return;
    setBranchLoadingByRepo((current) => ({ ...current, [repoId]: true }));
    setBranchErrors((current) => ({ ...current, [repoId]: "" }));
    try {
      const snapshot = await api.getRepositoryBranches(repoId);
      setBranchSnapshots((current) => ({ ...current, [repoId]: snapshot }));
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setBranchErrors((current) => ({ ...current, [repoId]: message || (error instanceof Error ? error.message : "Could not read repository branches.") }));
    } finally {
      setBranchLoadingByRepo((current) => ({ ...current, [repoId]: false }));
    }
  }

  async function refreshRepositoryRemotes(repoId: string) {
    const api = apiRef.current;
    if (!api) return;
    setRemoteLoadingByRepo((current) => ({ ...current, [repoId]: true }));
    setRemoteErrors((current) => ({ ...current, [repoId]: "" }));
    try {
      const snapshot = await api.getRepositoryRemotes(repoId);
      setRemoteSnapshots((current) => ({ ...current, [repoId]: snapshot }));
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setRemoteErrors((current) => ({ ...current, [repoId]: message || (error instanceof Error ? error.message : "Could not read repository remotes.") }));
    } finally {
      setRemoteLoadingByRepo((current) => ({ ...current, [repoId]: false }));
    }
  }

  async function submitRemoteTask(repoId: string, action: () => Promise<TaskSnapshotResponse>) {
    setRemoteActionBusy(true);
    setRemoteErrors((current) => ({ ...current, [repoId]: "" }));
    try {
      const task = await action();
      setTasks((current) => [task, ...current.filter((item) => item.taskId !== task.taskId)]);
      setTasksOpen(true);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setRemoteErrors((current) => ({ ...current, [repoId]: message || (error instanceof Error ? error.message : "Could not update repository remotes.") }));
    } finally {
      setRemoteActionBusy(false);
    }
  }

  function addRepositoryRemote(name: string, url: string) {
    const api = apiRef.current;
    const repoId = selectedRepository?.repoId;
    if (api && repoId) void submitRemoteTask(repoId, () => api.addRepositoryRemote(repoId, name, url));
  }

  function setRepositoryRemoteUrl(name: string, url: string) {
    const api = apiRef.current;
    const repoId = selectedRepository?.repoId;
    if (api && repoId) void submitRemoteTask(repoId, () => api.setRepositoryRemoteUrl(repoId, name, url));
  }

  function deleteRepositoryRemote(name: string) {
    const api = apiRef.current;
    const repoId = selectedRepository?.repoId;
    if (api && repoId) void submitRemoteTask(repoId, () => api.deleteRepositoryRemote(repoId, name));
  }

  function setRepositoryDefaultRemote(name: string | null) {
    const api = apiRef.current;
    const repoId = selectedRepository?.repoId;
    if (api && repoId) void submitRemoteTask(repoId, () => api.setRepositoryDefaultRemote(repoId, name));
  }

  function setRepositoryBranchUpstream(localBranch: string, remoteName: string, remoteBranch: string) {
    const api = apiRef.current;
    const repoId = selectedRepository?.repoId;
    if (api && repoId) void submitRemoteTask(repoId, () => api.setRepositoryBranchUpstream(repoId, localBranch, remoteName, remoteBranch));
  }

  async function toggleBranchFavorite(fullName: string, favorite: boolean) {
    const api = apiRef.current;
    const repository = selectedRepository;
    if (!api || !repository) return;
    try {
      const snapshot = await api.setRepositoryBranchFavorite(repository.repoId, fullName, !favorite);
      setBranchSnapshots((current) => ({ ...current, [repository.repoId]: snapshot }));
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setBranchErrors((current) => ({ ...current, [repository.repoId]: message || (error instanceof Error ? error.message : "Could not update branch favorite.") }));
    }
  }

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
      if (!preflight.isClean) return;
      const task = await api.switchRepositoryBranch(repository.repoId, switchTargetName);
      setTasks((current) => [task, ...current.filter((item) => item.taskId !== task.taskId)]);
      setBranchSwitcherOpen(false);
      setTasksOpen(true);
    } catch (error) {
      setSwitchError(error instanceof GitCrestApiError ? error.body.error.message : error instanceof Error ? error.message : "Could not switch branches.");
    } finally {
      setSwitchBusy(false);
    }
  }

  async function refreshTasks() {
    const api = apiRef.current;
    if (!api) return;
    try {
      setTasks(await api.listTasks());
      setTasksError("");
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "Could not read task history.");
    }
  }

  async function startWorkflowTask(task: TaskSnapshotResponse) {
    setTasks((current) => [task, ...current.filter((item) => item.taskId !== task.taskId)]);
    setWorkflowDialog(undefined);
    setTasksError("");
    setTasksOpen(true);
  }

  async function openWorkflowConflictWindow(task: TaskSnapshotResponse) {
    if (!task.repoId) return;
    try {
      await window.gitcrest.openConflictWindow({ repoId: task.repoId, taskId: task.taskId });
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

  async function fetchRepository() {
    const api = apiRef.current;
    const repoId = selectedRepository?.repoId;
    if (!api || !repoId) return;
    try {
      const task = await api.fetchRepository(repoId);
      setTasks((current) => [...current.filter((entry) => entry.taskId !== task.taskId), task]);
      setTasksError("");
      setTasksOpen(true);
    } catch (error) {
      setTasksError(error instanceof Error ? error.message : "Could not start a fetch task.");
      setTasksOpen(true);
    }
  }

  async function refreshPullPreflight(repoId = selectedRepository?.repoId) {
    const api = apiRef.current;
    if (!api || !repoId) return;
    setPullLoading(true);
    setPullError("");
    try {
      setPullPreflight(await api.preflightRepositoryPull(repoId));
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setPullPreflight(undefined);
      setPullError(message || (error instanceof Error ? error.message : "Could not preview the pull."));
    } finally {
      setPullLoading(false);
    }
  }

  function openPullDialog(repoId = selectedRepository?.repoId) {
    if (!repoId) return;
    if (repoId !== selectedRepository?.repoId) {
      const repository = repositories.find((entry) => entry.repoId === repoId);
      if (repository) activateRepository(repository);
    }
    setPullOpen(true);
    void refreshPullPreflight(repoId);
  }

  async function submitPull(strategy: components["schemas"]["PullRequest"]["strategy"]) {
    const api = apiRef.current;
    const repoId = selectedRepository?.repoId;
    const preview = pullPreflight;
    if (!api || !repoId || !preview || preview.repoId !== repoId || !preview.isClean || pullBusy) return;
    setPullBusy(true);
    setPullError("");
    try {
      const task = await api.pullRepository(repoId, {
        expectedLocalOid: preview.localOid,
        expectedTrackingOid: preview.trackingOid,
        strategy,
      });
      setTasks((current) => [task, ...current.filter((entry) => entry.taskId !== task.taskId)]);
      setTasksError("");
      setPullOpen(false);
      setTasksOpen(true);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setPullError(message || (error instanceof Error ? error.message : "Could not start the pull task."));
      if (error instanceof GitCrestApiError && ["PULL_PREFLIGHT_STALE", "PULL_REQUIRES_CLEAN"].includes(error.body.error.code)) {
        void refreshPullPreflight(repoId);
        void refreshRepositoryStatus(repoId);
      }
    } finally {
      setPullBusy(false);
    }
  }

  async function refreshPushPreflight(repoId = selectedRepository?.repoId, target: PushTarget | null = pushTarget || null) {
    const api = apiRef.current;
    if (!api || !repoId) return;
    setPushLoading(true);
    setPushError("");
    try {
      setPushPreflight(await api.preflightRepositoryPush(repoId, target || undefined));
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setPushPreflight(undefined);
      setPushError(message || (error instanceof Error ? error.message : "Could not preview the push."));
    } finally {
      setPushLoading(false);
    }
  }

  function openPushDialog(repoId = selectedRepository?.repoId, target?: PushTarget, forceOnly = false) {
    if (!repoId) return;
    if (repoId !== selectedRepository?.repoId) {
      const repository = repositories.find((entry) => entry.repoId === repoId);
      if (repository) activateRepository(repository);
    }
    setPushTarget(target);
    setPushForceOnly(forceOnly);
    setPushOpen(true);
    void refreshPushPreflight(repoId, target || null);
  }

  async function submitPush(forceWithLease: boolean) {
    const api = apiRef.current;
    const repoId = selectedRepository?.repoId;
    const preview = pushPreflight;
    if (!api || !repoId || !preview || preview.repoId !== repoId || pushBusy) return;
    setPushBusy(true);
    setPushError("");
    try {
      const task = await api.pushRepository(repoId, {
        expectedLocalOid: preview.localOid,
        expectedRemoteOid: preview.expectedRemoteOid,
        forceWithLease,
        remoteName: preview.remoteName,
        remoteBranch: preview.remoteBranch,
      });
      pushTargetsByTask.current.set(task.taskId, { remoteName: preview.remoteName, remoteBranch: preview.remoteBranch });
      setTasks((current) => [task, ...current.filter((entry) => entry.taskId !== task.taskId)]);
      setTasksError("");
      setPushOpen(false);
      setTasksOpen(true);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setPushError(message || (error instanceof Error ? error.message : "Could not start the push task."));
      if (error instanceof GitCrestApiError && error.body.error.code === "PUSH_PREFLIGHT_STALE") {
        void refreshPushPreflight(repoId, pushTarget || null);
      }
    } finally {
      setPushBusy(false);
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

  async function continueCommitPush(repoId: string, intent: CommitIntent) {
    const api = apiRef.current;
    if (!api) return;
    setPushTarget(intent.target);
    setPushForceOnly(intent.forceWithLease);
    setPushPreflight(undefined);
    setPushError("");
    setPushOpen(true);
    setPushLoading(true);
    try {
      const preview = await api.preflightRepositoryPush(repoId, intent.target);
      setPushPreflight(preview);
      if (intent.forceWithLease || preview.behind > 0 || preview.ahead === 0) return;
      setPushBusy(true);
      const task = await api.pushRepository(repoId, {
        expectedLocalOid: preview.localOid,
        expectedRemoteOid: preview.expectedRemoteOid,
        forceWithLease: false,
        remoteName: preview.remoteName,
        remoteBranch: preview.remoteBranch,
      });
      pushTargetsByTask.current.set(task.taskId, { remoteName: preview.remoteName, remoteBranch: preview.remoteBranch });
      setTasks((current) => [task, ...current.filter((entry) => entry.taskId !== task.taskId)]);
      setPushOpen(false);
      setTasksOpen(true);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setPushError(message || (error instanceof Error ? error.message : "The commit succeeded, but its push could not start."));
    } finally {
      setPushLoading(false);
      setPushBusy(false);
    }
  }

  async function stageChanges(action: StagingRequest["action"], path?: string) {
    const api = apiRef.current;
    const repoId = selectedRepository?.repoId;
    if (!api || !repoId || stagingBusy || hasActiveStagingTask) return;
    setStagingBusy(true);
    setTasksError("");
    try {
      const request: StagingRequest = { action, ...(path ? { path } : {}) };
      const task = await api.stageRepositoryChanges(repoId, request);
      setTasks((current) => [...current.filter((entry) => entry.taskId !== task.taskId), task]);
      setTasksOpen(true);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setTasksError(message || (error instanceof Error ? error.message : "Could not start the staging task."));
      setTasksOpen(true);
    } finally {
      setStagingBusy(false);
    }
  }

  async function stageSelectedChanges(selections: Array<{ hunkIndex: number; rowIndex?: number }>) {
    const api = apiRef.current;
    const repository = selectedRepository;
    const document = diffState.document;
    if (!api || !repository || !document || document.scope === "commit" || stagingBusy || hasActiveStagingTask) return;
    setStagingBusy(true);
    setTasksError("");
    try {
      const request: StagingPatchRequest = {
        action: document.scope === "index" ? "unstage" : "stage",
        path: document.path,
        scope: document.scope,
        revision: document.revision,
        selections,
      };
      const task = await api.stageSelectedDiffHunks(repository.repoId, request);
      setTasks((current) => [...current.filter((entry) => entry.taskId !== task.taskId), task]);
      setTasksOpen(true);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setTasksError(message || (error instanceof Error ? error.message : "Could not start the partial staging task."));
      setTasksOpen(true);
    } finally {
      setStagingBusy(false);
    }
  }

  function rememberCommitAction(action: CommitAction) {
    const repoId = selectedRepository?.repoId;
    if (!repoId) return;
    setWorkspaceSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [repoId]: {
          ...(current.tabs[repoId] || { mode: "graph", graphScrollTop: 0 }),
          commitAction: action,
        },
      },
    }));
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

  async function commitChanges(action: CommitAction = activeCommitAction, target?: PushTarget) {
    const api = apiRef.current;
    const repoId = selectedRepository?.repoId;
    if (!api || !repoId || !canCommit) return;
    if (action === "commitAndPushTo" && !target) {
      setPushTargetDialogOpen(true);
      return;
    }
    setCommitBusy(true);
    setTasksError("");
    try {
      const task = await api.commitRepository(repoId, commitMessage, { amend: amendCommit, signOff: signOffCommit, sign: signCommit, ...(commitSelections.length > 0 ? { selections: commitSelections } : {}) });
      setTasks((current) => [...current.filter((entry) => entry.taskId !== task.taskId), task]);
      commitSelectionsByTask.current.set(task.taskId, JSON.stringify(commitSelections));
      commitMessagesByTask.current.set(task.taskId, commitMessage);
      commitIntentsByTask.current.set(task.taskId, {
        action,
        ...(target ? { target } : {}),
        forceWithLease: action === "commitAndPushForce" || (action !== "commit" && amendCommit),
      });
      setTasksOpen(true);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      if (error instanceof GitCrestApiError && error.body.error.code === "RESOURCE_VERSION_STALE") {
        setCommitSelections([]);
        setDiffRetry((current) => current + 1);
        if (repoId) void refreshRepositoryStatus(repoId);
      }
      setTasksError(message || (error instanceof Error ? error.message : "Could not start the commit task."));
      setTasksOpen(true);
    } finally {
      setCommitBusy(false);
    }
  }

  function addDiffSelectionToCommit(selections: Array<{ hunkIndex: number; rowIndex?: number }>) {
    const document = diffState.document;
    if (!selectedRepository || !document || document.scope !== "index") return;
    const next = { path: document.path, revision: document.revision, selections };
    setCommitSelectionRepoId(selectedRepository.repoId);
    setCommitSelections((current) => [...current.filter((item) => item.path !== document.path), next]);
  }

  function chooseCommitTemplate(template: string) {
    setCommitTemplate(template);
    if (template === "conventional") setCommitMessage("feat: ");
    else if (template === "fix") setCommitMessage("fix: ");
    else setCommitMessage("");
  }

  async function startClone(remoteUrl: string, parentPath: string, directoryName: string) {
    const api = apiRef.current;
    if (!api) return;
    setCloneBusy(true);
    setCloneError("");
    setCloneDraft({ remoteUrl, parentPath, directoryName });
    try {
      const task = await api.cloneRepository(remoteUrl, parentPath, directoryName);
      cloneTaskIds.current.add(task.taskId);
      setTasks((current) => [...current.filter((entry) => entry.taskId !== task.taskId), task]);
      setCloneOpen(false);
      setTasksOpen(true);
      setTasksError("");
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setCloneError(message || (error instanceof Error ? error.message : "Could not start the clone task."));
    } finally {
      setCloneBusy(false);
    }
  }

  async function openClonedRepository(task: TaskSnapshotResponse) {
    if (!cloneTaskIds.current.has(task.taskId) || task.operation !== "clone" || task.status !== "succeeded" || !task.resultRepoId || openedCloneTasks.current.has(task.taskId)) return;
    openedCloneTasks.current.add(task.taskId);
    const api = apiRef.current;
    if (!api) return;
    try {
      const repository = await api.getRepository(task.resultRepoId);
      setRepositories((current) => [repository, ...current.filter((item) => item.repoId !== repository.repoId)]);
      activateRepository(repository);
      setCloneOpen(false);
      setTasksOpen(false);
      setTasksError("");
    } catch (error) {
      openedCloneTasks.current.delete(task.taskId);
      setTasksError(error instanceof Error ? error.message : "Clone completed, but the repository could not be opened.");
      setTasksOpen(true);
    }
  }

  function retryClone(task: TaskSnapshotResponse) {
    if (task.targetPath) {
      const separator = Math.max(task.targetPath.lastIndexOf("/"), task.targetPath.lastIndexOf("\\"));
      setCloneDraft((current) => ({ ...current, parentPath: task.targetPath!.slice(0, separator), directoryName: task.targetPath!.slice(separator + 1) }));
    }
    setCloneError("");
    setTasksOpen(false);
    setCloneOpen(true);
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
      await window.gitcrest.openDiffWindow({ repoId, path, scope, ...(commitOid ? { commitOid } : {}) });
    } catch (error) {
      setDiffState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not open the Diff window." }));
    }
  }

  function rememberGraphScroll(scrollTop: number) {
    const repoId = selectedRepository?.repoId;
    if (!repoId || mode !== "graph" || !Number.isFinite(scrollTop)) return;
    setWorkspaceSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [repoId]: { ...(current.tabs[repoId] || { mode: "graph", graphScrollTop: 0 }), graphScrollTop: Math.max(0, scrollTop) },
      },
    }));
  }

  function selectCommit(oid: string) {
    const repoId = selectedRepository?.repoId;
    if (!repoId) return;
    setWorkspaceSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [repoId]: { ...(current.tabs[repoId] || { mode: "graph", graphScrollTop: 0 }), selectedCommit: oid },
      },
    }));
  }

  function closeRepositoryTab(repoId: string) {
    const current = workspaceSessionRef.current;
    const openRepoIds = current.openRepoIds.filter((id) => id !== repoId);
    const closingActive = current.activeRepoId === repoId;
    const nextActiveRepoId = closingActive
      ? openRepoIds[openRepoIds.length - 1]
      : current.activeRepoId;
    const nextRepository = repositories.find((repository) => repository.repoId === nextActiveRepoId);
    setWorkspaceSession({ ...current, openRepoIds, activeRepoId: nextActiveRepoId });
    if (closingActive) setSelectedRepository(nextRepository);
    if (closingActive && page === "workspace") setPage(nextRepository ? "workspace" : "welcome");
  }

  async function openLocalRepository() {
    setOpenError("");
    try {
      const path = await window.gitcrest.chooseRepository();
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
      const path = await window.gitcrest.chooseRepository();
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
    let cancelled = false;
    let unsubscribeFromEvents: (() => void) | undefined;

    async function connect() {
      try {
        const connection = await window.gitcrest.getSidecarConnection();
        const api = new GitCrestApiClient(connection.baseUrl, connection.token);
        apiRef.current = api;
        const body = await api.getVersion();
        if (!cancelled) {
          setVersion(`${body.name} ${body.version} (API v${body.apiVersion})`);
          setStatus("Connected to local Rust core");
        }
        await refreshRepositories(api, true);

        const unsubscribe = await window.gitcrest.subscribeToEvents((event: components["schemas"]["EventEnvelope"]) => {
          if (event.type === "connection.resyncRequired") {
            void refreshRepositories(api).catch((syncError: unknown) => {
              if (!cancelled) {
                setStatus(syncError instanceof Error ? syncError.message : "Failed to refresh repository state");
              }
            });
          }
        });
        if (cancelled) unsubscribe();
        else unsubscribeFromEvents = unsubscribe;
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Failed to connect to local Rust core");
      }
    }

    void connect();
    return () => {
      cancelled = true;
      apiRef.current = undefined;
      unsubscribeFromEvents?.();
    };
  }, []);

  useEffect(() => {
    if (tasksOpen) void refreshTasks();
    const timer = window.setInterval(() => {
      if (tasksOpen || hasActiveTasksRef.current) void refreshTasks();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [tasksOpen]);

  useEffect(() => {
    const refreshAfterChildWindow = () => {
      void refreshTasks();
      const repoId = selectedRepository?.repoId;
      if (!repoId) return;
      void refreshRepositoryStatus(repoId);
      void refreshRepositoryBranches(repoId);
      setHistoryRefreshKey((current) => current + 1);
    };
    window.addEventListener("focus", refreshAfterChildWindow);
    return () => window.removeEventListener("focus", refreshAfterChildWindow);
  }, [selectedRepository?.repoId]);

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
    for (const task of tasks) void openClonedRepository(task);
  }, [tasks]);

  useEffect(() => {
    for (const task of tasks) {
      if (task.status === "waitingForInput" && (["merge", "cherryPick", "revert", "rebase"].includes(task.operation) || task.operation.startsWith("shelfApply:")) && task.repoId && !refreshedWaitingWorkflowTasks.current.has(task.taskId)) {
        refreshedWaitingWorkflowTasks.current.add(task.taskId);
        void refreshRepositoryStatus(task.repoId);
      }
      if (!["succeeded", "failed", "cancelled"].includes(task.status)) continue;
      if (task.operation.startsWith("stage") || task.operation.startsWith("unstage")) {
        if (refreshedStagingTasks.current.has(task.taskId)) continue;
        refreshedStagingTasks.current.add(task.taskId);
        if (task.repoId) void refreshRepositoryStatus(task.repoId);
      }
      if (task.operation === "commit") {
        if (refreshedCommitTasks.current.has(task.taskId)) continue;
        refreshedCommitTasks.current.add(task.taskId);
        const submittedSelection = commitSelectionsByTask.current.get(task.taskId);
        commitSelectionsByTask.current.delete(task.taskId);
        const submittedMessage = commitMessagesByTask.current.get(task.taskId);
        commitMessagesByTask.current.delete(task.taskId);
        const intent = commitIntentsByTask.current.get(task.taskId);
        commitIntentsByTask.current.delete(task.taskId);
        if (task.status === "succeeded" && submittedMessage === commitMessage) setCommitMessage("");
        if (task.status === "succeeded" && submittedSelection === JSON.stringify(commitSelections)) {
          setCommitSelections([]);
        }
        if (!task.repoId) continue;
        const api = apiRef.current;
        if (api) {
          void api.getRepository(task.repoId).then((repository) => {
            setRepositories((current) => current.map((entry) => entry.repoId === repository.repoId ? repository : entry));
            setSelectedRepository((current) => current?.repoId === repository.repoId ? repository : current);
          }).catch((error: unknown) => {
            setTasksError(error instanceof Error ? error.message : "Could not refresh repository metadata after commit.");
          });
        }
        void refreshRepositoryStatus(task.repoId);
        if (task.status === "succeeded" && intent && intent.action !== "commit") {
          void continueCommitPush(task.repoId, intent);
        }
      }
      if (task.operation.startsWith("branch")) {
        if (refreshedBranchTasks.current.has(task.taskId)) continue;
        refreshedBranchTasks.current.add(task.taskId);
        if (!task.repoId) continue;
        void refreshRepositoryBranches(task.repoId);
        const api = apiRef.current;
        if (api) {
          void api.getRepository(task.repoId).then((repository) => {
            setRepositories((current) => current.map((entry) => entry.repoId === repository.repoId ? repository : entry));
            setSelectedRepository((current) => current?.repoId === repository.repoId ? repository : current);
          }).catch(() => undefined);
        }
      }
      if (task.operation.startsWith("remote")) {
        if (refreshedRemoteTasks.current.has(task.taskId)) continue;
        refreshedRemoteTasks.current.add(task.taskId);
        if (!task.repoId) continue;
        void refreshRepositoryRemotes(task.repoId);
        if (task.operation === "remoteSetUpstream") void refreshRepositoryBranches(task.repoId);
      }
      if (task.operation.startsWith("push") && !refreshedPushTasks.current.has(task.taskId)) {
        refreshedPushTasks.current.add(task.taskId);
        if (task.status === "succeeded" && task.repoId) {
          void refreshRepositoryBranches(task.repoId);
          setHistoryRefreshKey((current) => current + 1);
        }
      }
      if (task.operation.startsWith("pull") && !refreshedPullTasks.current.has(task.taskId)) {
        refreshedPullTasks.current.add(task.taskId);
        if (!task.repoId) continue;
        void refreshRepositoryStatus(task.repoId);
        void refreshRepositoryBranches(task.repoId);
        setHistoryRefreshKey((current) => current + 1);
        const api = apiRef.current;
        if (api) {
          void api.getRepository(task.repoId).then((repository) => {
            setRepositories((current) => current.map((entry) => entry.repoId === repository.repoId ? repository : entry));
            setSelectedRepository((current) => current?.repoId === repository.repoId ? repository : current);
          }).catch(() => undefined);
        }
      }
      if (task.operation.startsWith("fetch") && !refreshedFetchTasks.current.has(task.taskId)) {
        refreshedFetchTasks.current.add(task.taskId);
        if (task.status === "succeeded" && task.repoId) {
          void refreshRepositoryBranches(task.repoId);
          setHistoryRefreshKey((current) => current + 1);
        }
      }
      if ((task.operation.startsWith("workflow") || task.operation.startsWith("shelfApply:") || ["merge", "cherryPick", "revert", "rebase"].includes(task.operation)) && !refreshedWorkflowTasks.current.has(task.taskId)) {
        refreshedWorkflowTasks.current.add(task.taskId);
        if (!task.repoId) continue;
        void refreshRepositoryStatus(task.repoId);
        void refreshRepositoryBranches(task.repoId);
        setHistoryRefreshKey((current) => current + 1);
        const api = apiRef.current;
        if (api) void api.getRepository(task.repoId).then((repository) => {
          setRepositories((current) => current.map((entry) => entry.repoId === repository.repoId ? repository : entry));
          setSelectedRepository((current) => current?.repoId === repository.repoId ? repository : current);
        }).catch(() => undefined);
      }
    }
  }, [tasks]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_SESSION_KEY, JSON.stringify(workspaceSession));
    } catch {
      // Repository tabs remain available for this session if local storage is unavailable.
    }
  }, [workspaceSession]);

  useEffect(() => {
    if (selectedRepository?.availability === "available") {
      void refreshRepositoryStatus(selectedRepository.repoId);
      void refreshRepositoryBranches(selectedRepository.repoId);
      void refreshRepositoryRemotes(selectedRepository.repoId);
    }
  }, [selectedRepository?.repoId]);

  useEffect(() => {
    setCommitSelections([]);
    setCommitSelectionRepoId(selectedRepository?.repoId);
    setCommitMessage("");
    setCommitTemplate("plain");
    setAmendCommit(false);
    setSignOffCommit(false);
    setSignCommit(false);
  }, [selectedRepository?.repoId]);

  useEffect(() => {
    const viewport = graphViewportRef.current;
    if (viewport && mode === "graph" && selectedRepository) {
      viewport.scrollTop = workspaceSession.tabs[selectedRepository.repoId]?.graphScrollTop || 0;
    }
  }, [selectedRepository?.repoId, mode, workspaceSession.tabs]);

  useEffect(() => {
    const systemTheme = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: light)")
      : undefined;
    const applyTheme = () => {
      document.documentElement.dataset.theme = theme === "system" ? (systemTheme?.matches ? "light" : "dark") : theme;
    };
    applyTheme();
    systemTheme?.addEventListener("change", applyTheme);
    try {
      window.localStorage.setItem("gitcrest-theme", theme);
    } catch {
      // The theme remains available for this session when storage is unavailable.
    }
    return () => systemTheme?.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    const repoId = selectedRepository?.repoId;
    if (!repoId) {
      setLayoutLoadedFor(undefined);
      return;
    }
    setLayoutLoadedFor(undefined);
    setSidebarWidth(readStoredNumber(`gitcrest-layout-${repoId}-sidebar-width`, readStoredNumber("gitcrest-sidebar-width", 236, 190, 340), 190, 340));
    setDetailsWidth(readStoredNumber(`gitcrest-layout-${repoId}-details-width`, readStoredNumber("gitcrest-details-width", 284, 220, 420), 220, 420));
    setWorkbenchHeight(readStoredNumber(`gitcrest-layout-${repoId}-workbench-height`, readStoredNumber("gitcrest-workbench-height", 204, 144, 360), 144, 360));
    setLayoutLoadedFor(repoId);
  }, [selectedRepository?.repoId]);

  useEffect(() => {
    const repoId = selectedRepository?.repoId;
    if (!repoId || layoutLoadedFor !== repoId) return;
    try {
      window.localStorage.setItem(`gitcrest-layout-${repoId}-sidebar-width`, String(sidebarWidth));
      window.localStorage.setItem(`gitcrest-layout-${repoId}-details-width`, String(detailsWidth));
      window.localStorage.setItem(`gitcrest-layout-${repoId}-workbench-height`, String(workbenchHeight));
    } catch {
      // Layout resizing remains available for this session if storage is unavailable.
    }
  }, [layoutLoadedFor, selectedRepository?.repoId, sidebarWidth, detailsWidth, workbenchHeight]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (page === "workspace" && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void commitChanges(event.shiftKey ? "commitAndPush" : "commit");
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        openPullDialog();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        openBranchSwitcher();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        setPaletteQuery("");
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [page, canCommit, commitMessage, amendCommit, signOffCommit, signCommit, commitSelections, commitSelectionRepoId, activeCommitAction, selectedRepository?.repoId, selectedRepository?.availability]);

  const layoutStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--details-width": `${detailsWidth}px`,
    "--workbench-height": `${workbenchHeight}px`,
  } as CSSProperties;

  const nextTheme = () => setTheme(themeCycle[(themeCycle.indexOf(theme) + 1) % themeCycle.length]);
  const commands = [
    { id: "welcome", label: "Go to Welcome", detail: "Return to recent repositories and quick actions", available: true, run: () => setPage("welcome") },
    { id: "workspace", label: "Go to Workspace", detail: "Open the Changes, Graph, and Commit workspace", available: true, run: () => setPage("workspace") },
    { id: "theme", label: "Cycle color theme", detail: `Current: ${theme}; next: ${themeCycle[(themeCycle.indexOf(theme) + 1) % themeCycle.length]}`, available: true, run: nextTheme },
    { id: "open", label: "Open local repository", detail: "Choose a local Git repository folder", available: true, run: () => { void openLocalRepository(); } },
    { id: "fetch", label: "Fetch from remotes", detail: "Start a cancellable fetch task", available: Boolean(selectedRepository), run: () => { void fetchRepository(); } },
    { id: "pull", label: "Pull current branch", detail: "Review worktree state and choose merge or rebase", available: Boolean(selectedRepository), run: () => openPullDialog() },
    { id: "push", label: "Push current branch", detail: "Review commits, target, and overwrite scope before pushing", available: Boolean(selectedRepository), run: () => openPushDialog() },
    { id: "clone", label: "Clone repository", detail: "Clone a remote using Git credentials", available: connected, run: () => { setCloneError(""); setCloneOpen(true); } },
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
        <button className="quietButton searchShortcut" type="button" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K Meta+K">
          <span aria-hidden="true">⌕</span><span>Search commands</span><kbd>{commandKey} K</kbd>
        </button>
        <button className="quietButton themeButton" type="button" onClick={nextTheme} aria-label={`Color theme: ${theme}. Activate to cycle theme`} title={`Theme: ${theme}`}>
          <span aria-hidden="true">◐</span><span>{theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}</span>
        </button>
        <button className="quietButton taskCenterButton" type="button" onClick={() => setTasksOpen(true)} aria-label={`Background tasks, ${tasks.filter((task) => task.status === "queued" || task.status === "running").length} active`}>
          Tasks <span className="countBadge">{tasks.filter((task) => task.status === "queued" || task.status === "running").length}</span>
        </button>
        <div className={`connectionBadge ${connected ? "connected" : ""}`} role="status" aria-live="polite" aria-label={status} title={status}>
          <span className="connectionDot" aria-hidden="true" />
          <span>{connectionLabel}</span>
        </div>
      </header>

      {page === "welcome" ? (
        <section className="welcomePage" aria-labelledby="welcome-title">
          <div className="welcomeIntro">
            <p className="sectionEyebrow">LOCAL GIT WORKSPACE</p>
            <h1 id="welcome-title">Your repositories,<br /><span>in good order.</span></h1>
            <p className="welcomeSummary">Review changes, follow branches, and make deliberate commits from one quiet place.</p>
            <div className="welcomeActions">
              <button className="primaryButton" type="button" disabled={openingRepository} onClick={() => void openLocalRepository()}>
                <span aria-hidden="true">＋</span> {openingRepository ? "Opening repository…" : "Open a repository"}
              </button>
              <button className="secondaryButton" type="button" disabled={!connected} onClick={() => { setCloneError(""); setCloneOpen(true); }}>Clone repository</button>
              <button className="textButton" type="button" onClick={() => setPage("workspace")}>Preview workspace</button>
            </div>
          </div>
          {openError && <div className="openRepositoryError" role="alert">{openError}</div>}
          <div className="welcomeColumns">
            <section className="recentSection" aria-labelledby="recent-heading">
              <div className="sectionHeading">
                <div><p className="sectionEyebrow">YOUR LIBRARY</p><h2 id="recent-heading">Recent repositories</h2></div>
                <span className="quietButton compact" aria-label="Favorites first, then most recently opened">Favorites first</span>
              </div>
              {repositories.length === 0 ? (
                <div className="emptyRepositories">
                  <div className="emptyGlyph" aria-hidden="true"><span /><span /><span /></div>
                  <h3>No repositories yet</h3>
                  <p>Open a local Git repository to see its changes, branches, and history here.</p>
                  <button className="inlineAction" type="button" onClick={() => void openLocalRepository()}>Choose a folder <span aria-hidden="true">→</span></button>
                </div>
              ) : (
                <div className="repositoryList">
                  {repositories.map((repository) => (
                    <div key={repository.repoId} className={`repositoryRow ${repository.availability === "missing" ? "repositoryMissing" : ""}`}>
                      <span className="repoStatusGlyph" aria-hidden="true">{repository.availability === "missing" ? "!" : "●"}</span>
                      <button className="repositoryRowOpen" type="button" disabled={openingRepository || repository.availability === "missing"} onClick={() => void openRecentRepository(repository)}>
                        <span className="repositoryRowText"><strong>{repositoryName(repository.path)}{repository.isFavorite ? " · Favorite" : ""}</strong><small>{repository.availability === "missing" ? `Unavailable · ${repository.path}` : repository.path}</small></span>
                        <span className="repositoryBranch">{repository.availability === "missing" ? "Missing" : repository.detached ? "Detached" : repository.branch || "Unborn"}</span>
                      </button>
                      <button className="repositoryRowAction" type="button" aria-label={repository.isFavorite ? `Remove ${repositoryName(repository.path)} from favorites` : `Favorite ${repositoryName(repository.path)}`} onClick={() => void toggleFavorite(repository)}>{repository.isFavorite ? "★" : "☆"}</button>
                      {repository.availability === "missing" && <button className="repositoryRowAction" type="button" onClick={() => void openLocalRepository()}>Locate</button>}
                      <button className="repositoryRowAction" type="button" aria-label={`Remove ${repositoryName(repository.path)} from recent repositories`} onClick={() => void forgetRepository(repository)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <aside className="quickActions" aria-labelledby="quick-heading">
              <div className="sectionHeading"><div><p className="sectionEyebrow">GET STARTED</p><h2 id="quick-heading">Quick actions</h2></div></div>
              <button className="actionRow" type="button" disabled={openingRepository} onClick={() => void openLocalRepository()}>
                <span className="actionIcon" aria-hidden="true">↗</span><span><strong>Open local repository</strong><small>Choose an existing folder</small></span><span className="actionArrow" aria-hidden="true">→</span>
              </button>
              <button className="actionRow" type="button" disabled={!connected} onClick={() => { setCloneError(""); setCloneOpen(true); }}>
                <span className="actionIcon" aria-hidden="true">⇣</span><span><strong>Clone a repository</strong><small>Bring a remote project here</small></span><span className="actionArrow" aria-hidden="true">→</span>
              </button>
              <button className="actionRow" type="button" disabled={openingRepository} onClick={() => void initializeLocalRepository()}>
                <span className="actionIcon" aria-hidden="true">＋</span><span><strong>Initialize a repository</strong><small>Start tracking a new project</small></span><span className="actionArrow" aria-hidden="true">→</span>
              </button>
              <div className="actionFootnote"><span className="infoIcon" aria-hidden="true">i</span> Initialize creates Git metadata only in the folder you select and keeps its files.</div>
            </aside>
          </div>
          <footer className="welcomeFooter"><span>Private by default</span><span className="footerDivider" /><span>Your repositories stay on this device</span><span className="footerSpacer" /><span>{version || "Local engine"}</span><button type="button" className="textButton" onClick={() => setPage("workspace")}>Explore the workspace <span aria-hidden="true">→</span></button></footer>
        </section>
      ) : (
        <section className="workspacePage" aria-label="Git workspace">
          <div className="workspaceToolbar">
            <div className="workspaceCrumb"><span className="crumbMark" aria-hidden="true">G</span><span>Workspace</span><span className="crumbSlash">/</span><span className="mutedText">{selectedRepository?.path || "No repository open"}</span></div>
            <div className="toolbarActions">
              <button className={mode === "graph" ? "modeButton active" : "modeButton"} type="button" onClick={() => changeWorkspaceMode("graph")}>Graph</button>
              <button className={mode === "diff" ? "modeButton active" : "modeButton"} type="button" disabled={!selectedFilePath} title={!selectedFilePath ? "Select a changed file to open Diff" : "Open the selected file diff"} onClick={() => changeWorkspaceMode("diff")}>Diff</button>
              <span className="toolbarDivider" />
              <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} title={pushDisabledReason || "Preview the current branch push"} onClick={() => openPushDialog()}>Push</button>
              <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} title={pullDisabledReason || "Review worktree state, then pull with merge or rebase (Ctrl/Cmd+Shift+L)"} onClick={() => openPullDialog()}>Pull</button>
              <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} title={selectedRepository ? "Fetch from configured remotes" : "Open a repository to fetch"} onClick={() => void fetchRepository()}>Fetch</button>
              <span className="toolbarDivider" />
              <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available"} title={selectedRepository ? "Switch branches (Ctrl/Cmd+B)" : "Open a repository to switch branches"} onClick={openBranchSwitcher}><span className="branchGlyph" aria-hidden="true">⑂</span> {selectedRepository ? selectedRepository.detached ? `Detached · ${selectedRepository.head?.slice(0, 7)}` : selectedRepository.branch || "Unborn branch" : "No branch"}</button>
            </div>
          </div>

          <div className={`workArea${mode === "diff" ? " diffMode" : ""}`}>
            <aside className="navigationPanel" aria-label="Repository navigation">
              <div className="panelHeading"><span>REPOSITORY</span><button className="panelMenu" type="button" disabled aria-label="Repository options">···</button></div>
              <div className="navGroup changesNavigation">
                <div className="navGroupTitle changesHeading"><span>Changes</span><span className="countBadge">{activeStatus ? activeStatus.files.length : "—"}</span></div>
                <div className="changeGroupActions">
                  <button type="button" disabled={!activeStatus || workingCount === 0 || activeStatus.files.some((file) => file.kind === "conflicted") || stagingBusy || hasActiveStagingTask} onClick={() => void stageChanges("stageAll")}>Stage all</button>
                  <button type="button" disabled={!activeStatus || stagedCount === 0 || activeStatus.files.some((file) => file.kind === "conflicted") || stagingBusy || hasActiveStagingTask} onClick={() => void stageChanges("unstageAll")}>Unstage all</button>
                </div>
                {!selectedRepository && <div className="navEmpty">No repository open</div>}
                {selectedRepository && !activeStatus && activeStatusLoading && <div className="navEmpty" role="status">Loading working tree status…</div>}
                {selectedRepository && !activeStatus && activeStatusError && <div className="statusLoadError" role="alert"><span>{activeStatusError}</span><button type="button" onClick={() => void refreshRepositoryStatus(selectedRepository.repoId)}>Retry</button></div>}
                {activeStatus && activeStatus.files.length === 0 && <div className="navEmpty">Working tree clean</div>}
                {activeStatus && activeStatusError && <div className="statusStaleNotice" role="status">Refresh failed. Showing the last snapshot.</div>}
                {statusGroups.filter((group) => group.files.length > 0).map((group) => (
                  <section className="changeGroup" key={group.category} aria-label={`${group.label} changes`}>
                    <div className="changeGroupTitle"><span>{group.label}</span><span>{group.files.length}</span></div>
                    {group.files.map((file) => (
                      <div className="statusFileRow" key={`${group.category}:${file.path}`}>
                        <button className={`statusFileItem statusFileButton${selectedFilePath === file.path && selectedFileScope === (group.category === "staged" ? "index" : "workingTree") ? " selected" : ""}`} type="button" aria-pressed={selectedFilePath === file.path && selectedFileScope === (group.category === "staged" ? "index" : "workingTree")} title={file.originalPath ? `${file.originalPath} → ${file.path}` : `Review ${file.path}`} onClick={() => openFileDiff(file.path, group.category === "staged" ? "index" : "workingTree")}>
                          <span className={`statusFileCode status-${file.kind}`} aria-label={file.kind}>{changeCode(file.kind)}</span>
                          <span className="statusFilePath">{file.path}</span>
                          {file.modeChanged && <span className="modeChangedTag" title="File mode changed">mode</span>}
                        </button>
                        <button
                          className="statusFileStageAction"
                          type="button"
                          disabled={stagingBusy || hasActiveStagingTask || file.kind === "conflicted" || group.category === "ignored" || group.category === "conflicted"}
                          aria-label={`${group.category === "staged" ? "Unstage" : "Stage"} ${file.path}`}
                          title={file.kind === "conflicted" ? "Resolve conflicts before staging" : `${group.category === "staged" ? "Unstage" : "Stage"} this file`}
                          onClick={() => void stageChanges(group.category === "staged" ? "unstageFile" : "stageFile", file.path)}
                        >{group.category === "staged" ? "−" : "+"}</button>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
              <div className="navDivider" />
              <div className="navGroup branchesNavigation">
                <div className="navGroupTitle"><span>Branches</span>{hasBranchSnapshot && <span className="countBadge">{orderedBranches.length}</span>}</div>
                {!selectedRepository && <div className="navEmpty">Open a repository to view branches</div>}
                {selectedRepository && activeBranchesLoading && !activeBranches && <div className="navEmpty" role="status">Loading branches…</div>}
                {selectedRepository && activeBranchError && <div className="statusLoadError" role="alert"><span>{activeBranchError}</span><button type="button" onClick={() => void refreshRepositoryBranches(selectedRepository.repoId)}>Retry</button></div>}
                {selectedRepository && hasBranchSnapshot && orderedBranches.length === 0 && <div className="navEmpty">No branches yet</div>}
                {selectedRepository && hasBranchSnapshot && orderedBranches.length > 0 && <ul className="branchList" aria-label="Repository branches">
                  {orderedBranches.map((branch) => (
                    <li className={`branchItem${branch.isCurrent ? " current" : ""}`} key={branch.fullName}>
                      <span className="branchItemGlyph" aria-hidden="true">{branch.kind === "remote" ? "⇢" : "⑂"}</span>
                      <span className="branchItemName" title={branch.fullName} aria-current={branch.isCurrent ? "page" : undefined}>{branch.name}</span>
                      {branch.isCurrent && <span className="branchCurrentLabel">HEAD</span>}
                      <button className={`branchFavorite${branch.isFavorite ? " active" : ""}`} type="button" aria-label={`${branch.isFavorite ? "Remove" : "Add"} ${branch.fullName} ${branch.isFavorite ? "from" : "to"} favorites`} aria-pressed={branch.isFavorite} onClick={() => void toggleBranchFavorite(branch.fullName, branch.isFavorite)}>{branch.isFavorite ? "★" : "☆"}</button>
                    </li>
                  ))}
                </ul>}
              </div>
              <div className="navDivider" />
              <RemoteManager
                snapshot={activeRemotes}
                branches={activeBranches}
                api={apiRef.current}
                openRequest={credentialManagerOpenRequest}
                onFetch={() => void fetchRepository()}
                loading={activeRemotesLoading}
                busy={remoteActionBusy}
                disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask}
                disabledReason={remoteDisabledReason}
                error={activeRemoteError || ""}
                onRefresh={() => { if (selectedRepository) void refreshRepositoryRemotes(selectedRepository.repoId); }}
                onAdd={addRepositoryRemote}
                onSetUrl={setRepositoryRemoteUrl}
                onDelete={deleteRepositoryRemote}
                onSetDefault={setRepositoryDefaultRemote}
                onSetUpstream={setRepositoryBranchUpstream}
              />
              {selectedRepository && apiRef.current ? <ShelfCenter
                key={selectedRepository.repoId}
                api={apiRef.current}
                repoId={selectedRepository.repoId}
                headOid={selectedRepository.head}
                files={activeStatus?.files || []}
                statusReady={Boolean(activeStatus)}
                disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask}
                refreshKey={historyRefreshKey}
                openComposerRequest={shelfComposerRequest}
                onTaskSubmitted={() => {
                  if (selectedRepository) void refreshRepositoryStatus(selectedRepository.repoId);
                  void refreshTasks();
                }}
              /> : <div className="navGroup"><div className="navGroupTitle">Shelves</div><div className="navEmpty">Open a repository to manage shelves</div></div>}
              <div className="panelFooter"><span className="statusIcon" aria-hidden="true">●</span> {connected ? "Engine ready" : connecting ? "Connecting to engine" : "Engine unavailable"}</div>
            </aside>
            <ResizeSeparator orientation="vertical" edge="left" value={sidebarWidth} min={190} max={340} label="Resize repository navigation" onResize={setSidebarWidth} />

            <section className="mainPanel" aria-label={mode === "graph" ? "Commit graph" : "File diff"}>
              <div className="panelHeading mainPanelHeading"><div className="viewTitle"><span className="viewGlyph" aria-hidden="true">◌</span><span>{mode === "graph" ? "Commit graph" : "Diff viewer"}</span><span className="subtleTag">LOCAL</span></div><button className="quietButton compact" type="button" disabled={!selectedRepository || activeStatusLoading} onClick={() => { if (selectedRepository) void refreshRepositoryStatus(selectedRepository.repoId); }} aria-label={activeStatusLoading ? "Refreshing working tree status" : "Refresh working tree status"} title={activeStatusLoading ? "Refreshing working tree status" : "Refresh working tree status"}>{activeStatusLoading ? "Refreshing…" : "Refresh ↻"}</button></div>
              {mode === "graph" ? selectedRepository && apiRef.current && isFullObjectId(selectedRepository.head) ? <CommitGraph
                key={selectedRepository.repoId}
                api={apiRef.current}
                repoId={selectedRepository.repoId}
                selectedOid={selectedCommit}
                initialScrollTop={workspaceSession.tabs[selectedRepository.repoId]?.graphScrollTop || 0}
                refreshKey={historyRefreshKey}
                onScrollPosition={rememberGraphScroll}
                onSelect={selectCommit}
              /> : <div className="graphViewport" ref={graphViewportRef} onScroll={(event) => rememberGraphScroll(event.currentTarget.scrollTop)} role="region" aria-label="Commit graph view"><div className="graphEmpty">
                <div className="graphIllustration" aria-hidden="true"><div className="graphLine" /><span className="graphNode nodeOne" /><span className="graphNode nodeTwo" /><span className="graphNode nodeThree" /><span className="graphNode nodeFour" /></div>
                <p className="sectionEyebrow">A CLEAR VIEW OF YOUR HISTORY</p>
                <h2>{selectedRepository ? selectedRepository.head ? "Connecting to history…" : "No commits yet" : "Your commit graph starts here"}</h2>
                <p>{selectedRepository ? `${selectedRepository.path}${selectedRepository.branch ? ` · ${selectedRepository.branch}` : selectedRepository.detached ? " · detached HEAD" : " · unborn branch"}` : "Open a repository to explore commits, branches, and the changes that connect them."}</p>
                {!selectedRepository && <button className="secondaryButton" type="button" onClick={() => void openLocalRepository()} disabled={openingRepository}>Open repository <span aria-hidden="true">→</span></button>}
              </div></div>
                : !selectedRepository || !selectedFilePath || !selectedFileScope ? <div className="graphViewport"><div className="diffSpecialState"><h2>Choose a changed file</h2><p>Select a file from Changes to review its working tree or staged diff.</p></div></div>
                  : diffState.key !== activeDiffKey || diffState.loading ? <div className="diffSpecialState" role="status"><span className="loadingSpinner" aria-hidden="true" />Reading file diff…</div>
                  : diffState.error ? <div className="diffSpecialState" role="alert"><p>{diffState.error}</p><button className="secondaryButton" type="button" onClick={() => setDiffRetry((current) => current + 1)}>Retry diff</button></div>
                  : diffState.document ? <div className="graphViewport"><SplitDiff document={diffState.document} onStageSelection={stageSelectedChanges} onCommitSelection={addDiffSelectionToCommit} onOpenWindow={() => void openDiffWindow(selectedFilePath, selectedFileScope ?? "workingTree", selectedDiffCommitOid)} disabled={diffState.document.scope === "commit" || stagingBusy || hasActiveStagingTask || commitBusy} /></div>
                  : <div className="graphViewport"><div className="diffSpecialState" role="status"><p>{selectedDiffFile ? "Preparing file diff…" : "This file is no longer in the latest change snapshot."}</p></div></div>}
              <div className="panelFooter mainPanelFooter"><span>History is read from your local repository</span><span className="footerSpacer" />{version || "Local engine"}</div>
            </section>
            {mode === "graph" && <ResizeSeparator orientation="vertical" edge="right" value={detailsWidth} min={220} max={420} label="Resize commit details" onResize={setDetailsWidth} />}

            {mode === "graph" && <aside className="detailsPanel" aria-label="Commit details">
              <div className="panelHeading">{selectedRepository ? "REPOSITORY" : "COMMIT DETAILS"}</div>
              {selectedRepository && isFullObjectId(selectedCommit) && apiRef.current ? <CommitDetails api={apiRef.current} repoId={selectedRepository.repoId} oid={selectedCommit} onOpenFile={openCommitFileDiff} onOpenDiffWindow={(path, oid) => void openDiffWindow(path, "commit", oid)} workflowDisabledReason={!connected ? "Connect to the Git engine to start this operation." : selectedRepository.availability !== "available" ? "This repository is unavailable." : hasActiveRepositoryTask ? "Wait for the current repository task." : undefined} onWorkflow={(action, oid) => setWorkflowDialog({ repoId: selectedRepository.repoId, targetOid: oid, action })} /> : selectedRepository ? (
                <div className="repositoryDetails">
                  <span className="detailsGlyph" aria-hidden="true">G</span>
                  <h2>{repositoryName(selectedRepository.path)}</h2>
                  <p>{selectedRepository.path}</p>
                  <div className="repositoryFact"><span>BRANCH</span><strong>{selectedRepository.detached ? "Detached HEAD" : selectedRepository.branch || "Unborn"}</strong></div>
                  <div className="repositoryFact"><span>{selectedCommit && selectedCommit !== selectedRepository.head ? "SELECTED COMMIT" : "HEAD"}</span><strong className="monoText">{selectedCommit?.slice(0, 12) || "No commits"}</strong></div>
                  <div className="repositoryFact"><span>REPO ID</span><strong className="monoText">{selectedRepository.repoId.slice(0, 17)}…</strong></div>
                </div>
              ) : (
                <><div className="detailsEmpty"><span className="detailsGlyph" aria-hidden="true">⌁</span><h2>No commit selected</h2><p>Select a commit in the graph to inspect its message, author, and changed files.</p></div><div className="detailPlaceholder"><span>AUTHOR</span><strong>—</strong><span>COMMIT</span><strong className="monoText">—</strong></div></>
              )}
            </aside>}
          </div>

          <ResizeSeparator orientation="horizontal" edge="bottom" value={workbenchHeight} min={144} max={360} label="Resize changes and commit area" onResize={setWorkbenchHeight} />
          <section className="workbench" aria-label="Changes and commit">
            <div className="workbenchSection"><div className="workbenchTitle">Working tree <span className="countBadge">{activeStatus ? workingCount : "—"}</span></div><p>{!selectedRepository ? "No changed files" : activeStatusLoading && !activeStatus ? "Reading working tree…" : activeStatusError && !activeStatus ? activeStatusError : workingCount === 0 ? "Working tree clean" : "Unstaged changes"}</p><small>{selectedRepository && activeStatusLoading ? "Refreshing repository status…" : selectedRepository && !activeStatus && !activeStatusError ? "Waiting for the first status snapshot." : "Working tree changes are read from Git."}</small></div>
            <div className="workbenchSection stagedSection"><div className="workbenchTitle">Staged changes <span className="countBadge">{activeStatus ? stagedCount : "—"}</span></div><div className="stagedEmpty">{!activeStatus ? activeStatusError || "Waiting for repository status…" : stagedCount === 0 ? "Nothing staged" : `${stagedCount} staged file${stagedCount === 1 ? "" : "s"}`}</div><small>Review staged files before the commit workflow becomes available.</small></div>
            <div className="workbenchSection commitSection">
              <label className="workbenchTitle" htmlFor="commit-message">Commit message</label>
              <label className="srOnly" htmlFor="commit-template">Message template</label>
              <select id="commit-template" aria-label="Message template" value={commitTemplate} disabled={!selectedRepository || !connected || commitBusy} onChange={(event) => chooseCommitTemplate(event.target.value)}>
                <option value="plain">Plain message</option>
                <option value="conventional">Conventional commit</option>
                <option value="fix">Fix</option>
              </select>
              <textarea id="commit-message" aria-label="Commit message" placeholder="Describe the changes you want to commit…" value={commitMessage} disabled={!selectedRepository || !connected || commitBusy} onChange={(event) => setCommitMessage(event.target.value)} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void commitChanges(event.shiftKey ? "commitAndPush" : "commit"); } }} />
              {commitSelections.length > 0 && <div className="commitSelectionNotice" role="status">{commitSelections.length} staged file selection{commitSelections.length === 1 ? "" : "s"} will be committed. Other staged changes stay in the index. <button type="button" onClick={() => setCommitSelections([])}>Clear selection</button></div>}
              <div className="commitControls">
                <div className="commitOptions">
                  <label className="disabledCheck"><input type="checkbox" checked={amendCommit} disabled={!selectedRepository?.head || commitBusy} onChange={(event) => setAmendCommit(event.target.checked)} /> Amend</label>
                  <label className="disabledCheck"><input type="checkbox" checked={signOffCommit} disabled={!selectedRepository || commitBusy} onChange={(event) => setSignOffCommit(event.target.checked)} /> Sign-off</label>
                  <label className="disabledCheck"><input type="checkbox" checked={signCommit} disabled={!selectedRepository || commitBusy} onChange={(event) => setSignCommit(event.target.checked)} /> Sign</label>
                </div>
                <div className={`commitSplit${commitActionIsDanger ? " danger" : ""}`}>
                  <button className="primaryButton commitButton" type="button" disabled={!canCommit} title={!connected ? "Connect to the Git engine to commit" : hasConflicts ? "Resolve conflicts before committing" : stagedCount === 0 ? "Stage changes before committing" : !commitMessage.trim() ? "Enter a commit message" : hasActiveRepositoryTask ? "Wait for the current repository task" : commitActionIsDanger ? "Commit, then review the force-with-lease target and overwrite scope" : "Run the selected commit action"} onClick={() => runCommitAction(activeCommitAction)}>{commitBusy ? "Submitting…" : commitActionLabel}</button>
                  <button className="commitSplitMenuButton" type="button" disabled={!selectedRepository || commitBusy} aria-label="Choose commit action" aria-haspopup="menu" aria-expanded={commitActionMenuOpen} onClick={() => setCommitActionMenuOpen((open) => !open)}>▾</button>
                  {commitActionMenuOpen && <div className="commitActionMenu" role="menu" aria-label="Commit actions">
                    <button type="button" role="menuitemradio" aria-checked={activeCommitAction === "commit"} disabled={!canCommit} onClick={() => chooseCommitAction("commit")}>Commit</button>
                    <button type="button" role="menuitemradio" aria-checked={activeCommitAction === "commitAndPush"} disabled={!canCommit} onClick={() => chooseCommitAction("commitAndPush")}>Commit and Push</button>
                    <button type="button" role="menuitemradio" aria-checked={activeCommitAction === "commitAndPushTo"} disabled={!canCommit} onClick={() => chooseCommitAction("commitAndPushTo")}>Commit and Push to…</button>
                    <button className="dangerMenuItem" type="button" role="menuitemradio" aria-checked={activeCommitAction === "commitAndPushForce"} disabled={!canCommit} onClick={() => chooseCommitAction("commitAndPushForce")}>Commit and Push (force-with-lease)…</button>
                  </div>}
                </div>
              </div>
              {amendCommit && <p className="amendAdvisory" role="status">Amend replaces the current HEAD commit and changes its ID.</p>}
              {sensitiveStagedPaths.length > 0 && <p className="commitAdvisory" role="status">Review sensitive staged files before committing: {sensitiveStagedPaths.join(", ")}</p>}
              <small>Use Ctrl+Enter to commit. Only staged changes are included.</small>
            </div>
          </section>
          <footer className="statusbar"><span className="statusIcon" aria-hidden="true">●</span>{connected ? "Git engine ready" : connecting ? "Connecting to Git engine" : "Git engine unavailable"}<span className="statusbarDivider" /><span>{version || "API v1"}</span><span className="footerSpacer" /><span>Repository actions planned for S1</span></footer>
        </section>
      )}

      {branchSwitcherOpen && selectedRepository && (
        <div className="paletteBackdrop branchSwitcherBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !switchBusy) setBranchSwitcherOpen(false); }}>
          <section className="branchSwitcherDialog" role="dialog" aria-modal="true" aria-labelledby="branch-switcher-title">
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
                    <button className="secondaryButton" type="button" disabled={switchBusy || !connected || hasActiveRepositoryTask} title="Choose the changed files or hunks to save, then review the branch switch again" onClick={() => { setBranchSwitcherOpen(false); setShelfComposerRequest((request) => request + 1); }}>Shelve changes</button>
                    <button className="secondaryButton" type="button" disabled title="Commit or shelve the listed changes, then run preflight again">Continue</button>
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
            <div className="branchSwitcherHint"><kbd>{commandKey} B</kbd> opens this switcher <span>Esc closes</span></div>
          </section>
        </div>
      )}

      {paletteOpen && (
        <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaletteOpen(false); }}>
          <section
            className="commandPalette"
            role="dialog"
            aria-modal="true"
            aria-labelledby="palette-title"
            onKeyDown={(event) => {
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
            <div className="paletteSearch"><span aria-hidden="true">⌕</span><input autoFocus aria-label="Search commands" placeholder="Search commands…" value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} /><kbd>ESC</kbd></div>
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

      {pushOpen && <PushDialog snapshot={pushPreflight} loading={pushLoading} busy={pushBusy} error={pushError} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} disabledReason={pushDisabledReason} forceWithLeaseOnly={pushForceOnly} onRefresh={() => void refreshPushPreflight()} onFetch={fetchFromPushDialog} onPush={(forceWithLease) => void submitPush(forceWithLease)} onClose={() => setPushOpen(false)} />}
      {pushTargetDialogOpen && <PushTargetDialog remotes={activeRemotes} branches={activeBranches} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask || !canCommit} disabledReason={hasActiveRepositoryTask ? "Wait for the current repository task." : !canCommit ? "Stage changes and enter a commit message first." : remoteDisabledReason} onChoose={(target) => { setPushTargetDialogOpen(false); void commitChanges("commitAndPushTo", target); }} onClose={() => setPushTargetDialogOpen(false)} />}
      {pullOpen && <PullDialog snapshot={pullPreflight} loading={pullLoading} busy={pullBusy} error={pullError} disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} disabledReason={pullDisabledReason} onRefresh={() => void refreshPullPreflight()} onPull={(strategy) => void submitPull(strategy)} onClose={() => setPullOpen(false)} />}
      {tasksOpen && <TaskCenter api={apiRef.current} tasks={tasks} error={tasksError} actionId={taskActionId} onClose={() => setTasksOpen(false)} onRefresh={() => void refreshTasks()} onCancel={(taskId) => void cancelTask(taskId)} onCopy={(task) => void copyTaskLogs(task)} onRetryClone={retryClone} onConfigureCredentials={configureTaskCredentials} onReviewPush={reviewTaskPush} onRecoverWorkflow={(task, preview, action) => void recoverWorkflowTask(task, preview, action)} onOpenConflictWindow={(task) => void openWorkflowConflictWindow(task)} />}
      {workflowDialog && apiRef.current && <WorkflowDialog api={apiRef.current} repoId={workflowDialog.repoId} targetOid={workflowDialog.targetOid} action={workflowDialog.action} onClose={() => setWorkflowDialog(undefined)} onStarted={(task) => void startWorkflowTask(task)} />}
      {cloneOpen && <CloneDialog initialRemoteUrl={cloneDraft.remoteUrl} initialDirectoryName={cloneDraft.directoryName} parentPath={cloneDraft.parentPath} error={cloneError} busy={cloneBusy} api={apiRef.current} onChooseParent={() => window.gitcrest.chooseCloneParent()} onClose={() => setCloneOpen(false)} onSubmit={(remoteUrl, parentPath, directoryName) => void startClone(remoteUrl, parentPath, directoryName)} />}
    </main>
  );
}

export default App;
