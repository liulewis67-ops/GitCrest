import { useGlobalShortcuts } from "../use-global-shortcuts";
import { isFullGitObjectId } from "../../features/history";
import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";
import type { DiffArea } from "./use-app-diff";
import type { Work } from "./use-app-work";
import type { Navigation } from "./use-app-navigation";
import type { CommitActions } from "./use-app-commit-actions";

export function useAppShortcuts(ctx: Shell & Connection & Repositories & DiffArea & Work & Navigation & CommitActions) {
  const { repositoryReadable, activeBranches, activeStatus, activeStatusLoading, branchSwitcher, changeWorkspaceMode, cloneSubmission, commitBusy, commitChanges, connected, diffTarget, dismissTransientPanels, fetchRepository, hasActiveRepositoryTask, hasActiveStagingTask, hasConflicts, historyRequests, isMacPlatform, mode, openPullDialog, openPushDialog, openTagEditor, page, refreshRepositoryStatus, repositoryOpening, requestShelfComposer, selectedCommit, selectedFilePath, selectedRepository, setCommitAssistantOpen, setCommitPanelTab, setFocusMode, setPaletteOpen, setPaletteQuery, setSettingsView, setSidebarHidden, shortcuts, stageChanges, stagedCount, stagingBusy, toggleFocusMode, toggleInspector, toggleSidebar, undoRecentOperation, updateDiffViewPreferences, workflowDialog, workingCount } = ctx;

  useGlobalShortcuts({
    page,
    shortcuts,
    isMacPlatform,
    connected,
    repository: selectedRepository ? { repoId: selectedRepository.repoId, availability: repositoryReadable ? selectedRepository.availability : "missing" } : undefined,
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
}
