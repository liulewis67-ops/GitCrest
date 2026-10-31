import { requireGitCrestBridge } from "../../api/bridge";
import { type WorkspaceMode } from "../../features/repositories";
import { isFullGitObjectId } from "../../features/history";
import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";
import type { DiffArea } from "./use-app-diff";
import type { Work } from "./use-app-work";

export function useAppNavigation(ctx: Shell & Connection & Repositories & DiffArea & Work) {
  const { cloneSubmission, diffQuery, focusMode, historyRequests, inspectorOverlay, inspectorVisible, mode, overlayInspectorFor, panelPreferences, repositoryTabLifecycle, selectedRepository, setCommitPanelTab, setFocusMode, setInspectorOpen, setOverlayInspectorFor, setPage, setSettingsView, setShelfComposerRequest, setSidebarHidden, settingsView, workspaceSessionActions } = ctx;

  function openAccountSettings(credentialHosts: string[] = [], reopenClone = false) {
    setSettingsView({ section: "accounts", credentialHosts, reopenClone });
  }

  function closeSettings() {
    const reopenClone = settingsView?.reopenClone;
    setSettingsView(undefined);
    if (reopenClone) cloneSubmission.openDialog();
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

  return { openAccountSettings, closeSettings, changeWorkspaceMode, toggleSidebar, openInspector, closeInspector, toggleInspector, toggleFocusMode, dismissTransientPanels, requestShelfComposer, showFileHistory, showCommitComposer, openTagEditor, openFileDiff, openCommitFileDiff, openDiffWindow, closeRepositoryTab };
}

export type Navigation = ReturnType<typeof useAppNavigation>;
