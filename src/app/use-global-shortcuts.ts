import { useEffect, useRef } from "react";
import { matchesShortcut, type ShortcutPreferences } from "../features/settings";
import { isFullGitObjectId } from "../features/history";
import { AI_FEATURES_ENABLED } from "../shared/lib/feature-flags";

type ShortcutRepository = {
  repoId: string;
  availability: string;
};

type GlobalShortcutContext = {
  page: "welcome" | "workspace";
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  connected: boolean;
  repository?: ShortcutRepository;
  selectedCommit?: string;
  repositoryHeadIsFull: boolean;
  hasActiveStatus: boolean;
  workingCount: number;
  hasConflicts: boolean;
  stagingBusy: boolean;
  hasActiveStagingTask: boolean;
  hasActiveRepositoryTask: boolean;
  activeStatusLoading: boolean;
  hasSelectedFile: boolean;
  stagedCount: number;
  commitBusy: boolean;
  hasActiveBranches: boolean;
};

type GlobalShortcutActions = {
  openRepository: () => void;
  cloneRepository: () => void;
  initializeRepository: () => void;
  stageAll: () => void;
  undoRecentOperation: () => void;
  fetch: () => void;
  push: () => void;
  refreshStatus: (repoId: string) => void;
  openDiff: () => void;
  searchCommits: (repoId: string) => void;
  openShelfComposer: () => void;
  cherryPick: (repoId: string, commitOid: string) => void;
  createTag: (repoId: string, commitOid: string) => void;
  openSettings: () => void;
  commit: () => void;
  commitAndPush: () => void;
  pull: () => void;
  rebase: () => void;
  openBranchSwitcher: () => void;
  toggleCommandPalette: () => void;
  openCommitAssistant: () => void;
  closeCommandPalette: () => void;
  showView: (view: "changes" | "history") => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  toggleFocusMode: () => void;
  dismissTransientPanels: () => void;
};

export function useGlobalShortcuts(context: GlobalShortcutContext, actions: GlobalShortcutActions) {
  const latest = useRef({ context, actions });
  latest.current = { context, actions };

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.isComposing) return;
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      if (target?.closest('[role="dialog"], [role="alertdialog"]') && event.key !== "Escape") return;

      const { context: state, actions: run } = latest.current;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) {
        // View switches mean nothing to a text field, so they work while typing; everything else is left to the field.
        const view = (["viewChanges", "viewHistory"] as const).find((action) => matchesShortcut(event, state.shortcuts[action], state.isMacPlatform));
        if (view && state.page === "workspace" && state.repository) {
          event.preventDefault();
          run.showView(view === "viewChanges" ? "changes" : "history");
        }
        return;
      }
      const { shortcuts, isMacPlatform, page, connected, repository } = state;
      const repositoryAvailable = repository?.availability === "available";

      if (matchesShortcut(event, shortcuts.openRepository, isMacPlatform)) {
        event.preventDefault();
        run.openRepository();
      } else if (matchesShortcut(event, shortcuts.cloneRepository, isMacPlatform) && connected) {
        event.preventDefault();
        run.cloneRepository();
      } else if (matchesShortcut(event, shortcuts.initializeRepository, isMacPlatform)) {
        event.preventDefault();
        run.initializeRepository();
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.stageAll, isMacPlatform) && state.hasActiveStatus && state.workingCount > 0 && !state.hasConflicts && !state.stagingBusy && !state.hasActiveStagingTask) {
        event.preventDefault();
        run.stageAll();
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.undoRecentOperation, isMacPlatform) && repository && connected && repositoryAvailable && !state.hasActiveRepositoryTask) {
        event.preventDefault();
        run.undoRecentOperation();
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.fetch, isMacPlatform) && repository && connected && repositoryAvailable && !state.hasActiveRepositoryTask) {
        event.preventDefault();
        run.fetch();
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.push, isMacPlatform) && repository && connected && repositoryAvailable && !state.hasActiveRepositoryTask) {
        event.preventDefault();
        run.push();
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.refreshStatus, isMacPlatform) && repository && !state.activeStatusLoading) {
        event.preventDefault();
        run.refreshStatus(repository.repoId);
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.openDiff, isMacPlatform) && state.hasSelectedFile) {
        event.preventDefault();
        run.openDiff();
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.searchCommits, isMacPlatform) && repository && state.repositoryHeadIsFull) {
        event.preventDefault();
        run.searchCommits(repository.repoId);
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.shelve, isMacPlatform) && repository) {
        event.preventDefault();
        run.openShelfComposer();
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.cherryPick, isMacPlatform) && repository && isFullGitObjectId(state.selectedCommit) && connected && repositoryAvailable && !state.hasActiveRepositoryTask) {
        event.preventDefault();
        run.cherryPick(repository.repoId, state.selectedCommit);
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.createTag, isMacPlatform) && repository && isFullGitObjectId(state.selectedCommit) && connected && repositoryAvailable && !state.hasActiveRepositoryTask) {
        event.preventDefault();
        run.createTag(repository.repoId, state.selectedCommit);
      } else if (matchesShortcut(event, shortcuts.settings, isMacPlatform)) {
        event.preventDefault();
        run.openSettings();
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.commit, isMacPlatform)) {
        event.preventDefault();
        run.commit();
      } else if (page === "workspace" && matchesShortcut(event, shortcuts.commitAndPush, isMacPlatform)) {
        event.preventDefault();
        run.commitAndPush();
      } else if (matchesShortcut(event, shortcuts.pull, isMacPlatform)) {
        event.preventDefault();
        run.pull();
      } else if (matchesShortcut(event, shortcuts.rebase, isMacPlatform)) {
        event.preventDefault();
        if (repository && state.hasActiveBranches) run.rebase();
      } else if (matchesShortcut(event, shortcuts.branchSwitcher, isMacPlatform)) {
        event.preventDefault();
        run.openBranchSwitcher();
      } else if (matchesShortcut(event, shortcuts.commandPalette, isMacPlatform)) {
        event.preventDefault();
        run.toggleCommandPalette();
      } else if (AI_FEATURES_ENABLED && page === "workspace" && matchesShortcut(event, shortcuts.aiCommitMessage, isMacPlatform) && repository && state.stagedCount > 0 && !state.hasConflicts && !state.commitBusy) {
        event.preventDefault();
        run.openCommitAssistant();
      } else if (page === "workspace" && repository && matchesShortcut(event, shortcuts.viewChanges, isMacPlatform)) {
        event.preventDefault();
        run.showView("changes");
      } else if (page === "workspace" && repository && matchesShortcut(event, shortcuts.viewHistory, isMacPlatform)) {
        event.preventDefault();
        run.showView("history");
      } else if (page === "workspace" && repository && matchesShortcut(event, shortcuts.toggleSidebar, isMacPlatform)) {
        event.preventDefault();
        run.toggleSidebar();
      } else if (page === "workspace" && repository && matchesShortcut(event, shortcuts.toggleInspector, isMacPlatform)) {
        event.preventDefault();
        run.toggleInspector();
      } else if (page === "workspace" && repository && matchesShortcut(event, shortcuts.focusMode, isMacPlatform)) {
        event.preventDefault();
        run.toggleFocusMode();
      } else if (event.key === "Escape") {
        run.closeCommandPalette();
        // Esc inside a dialog or menu belongs to it; elsewhere it leaves focus mode or closes a floating panel.
        if (!target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) run.dismissTransientPanels();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
