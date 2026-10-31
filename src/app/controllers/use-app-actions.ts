import { useEffect } from "react";
import { type TaskSnapshotResponse } from "../../api/client";
import { getGitCrestBridge, requireGitCrestBridge } from "../../api/bridge";
import { useGlobalShortcuts } from "../use-global-shortcuts";
import { notify } from "../../shared/notices/notice-store";
import { type CommitAction } from "../../features/commits";
import { httpsHostFromRemote } from "../../shared/lib/https-remote-host";
import { type WorkspaceMode } from "../../features/repositories";
import { reconcileWorkingSelection } from "../../features/changes";
import { isFullGitObjectId } from "../../features/history";
import { useTaskRefreshEffects } from "../../features/tasks";
import { type PushTarget } from "../../features/remotes";

import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";
import type { DiffArea } from "./use-app-diff";
import type { Work } from "./use-app-work";

export function useAppActions(ctx: Shell & Connection & Repositories & DiffArea & Work) {
  const { activeBranches, activeCommitAction, activeStatus, activeStatusLoading, addCommitDiffSelection, apiRef, branchSwitcher, canCommit, clearCommittedDraft, cloneSubmission, commitBusy, commitSubmission, connected, continueCommitPush, diffQuery, diffState, diffTarget, fetchRepository, focusMode, hasActiveRepositoryTask, hasActiveStagingTask, hasConflicts, historyRequests, inspectorOverlay, inspectorVisible, isMacPlatform, mode, openPullDialog, openPushDialog, overlayInspectorFor, page, panelPreferences, refreshRepositoryBranches, refreshRepositoryRemotes, refreshRepositoryStatus, rememberCommitAction, remoteSnapshots, repositoryOpening, repositoryTabLifecycle, requestDiscard, reviewableFiles, selectedCommit, selectedFilePath, selectedFileScope, selectedRepository, setCommitActionMenuOpen, setCommitAssistantOpen, setCommitPanelTab, setFocusMode, setInspectorOpen, setNotice, setOverlayInspectorFor, setPage, setPaletteOpen, setPaletteQuery, setPushTargetDialogOpen, setRepositories, setSelectedRepository, setSettingsView, setShelfComposerRequest, setSidebarHidden, setTasksError, setTasksOpen, settingsView, shortcuts, stageChanges, stagedCount, stagingBusy, t, tasks, undoRecentOperation, updateDiffViewPreferences, windowSizeClass, workflowDialog, workingCount, workspaceSessionActions } = ctx;

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
      notify.success(t("hv.copied", { oid: oid.slice(0, 7) }));
    } catch {
      setNotice(t("hv.copyFailed"));
    }
  }

  async function copyBranchName(name: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(name);
      notify.success(t("bs.copiedName", { name }));
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
    hasDiffTarget: Boolean(diffTarget),
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
    toggleDiffView: () => updateDiffViewPreferences((current) => ({ sideBySide: !current.sideBySide })),
    dismissTransientPanels,
  });
  return { runCommitAction, chooseCommitAction, commitChanges, addDiffSelectionToCommit, openAccountSettings, closeSettings, configureTaskCredentials, changeWorkspaceMode, toggleSidebar, closeInspector, toggleInspector, toggleFocusMode, requestShelfComposer, showFileHistory, rollbackFile, revealFile, showCommitComposer, openTagEditor, copyCommitSha, copyBranchName, openFileDiff, openCommitFileDiff, openDiffWindow, closeRepositoryTab };
}

export type Actions = ReturnType<typeof useAppActions>;
