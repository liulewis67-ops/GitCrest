import { Suspense } from "react";
import { createPaletteCommands } from "../commands/palette-commands";
import { CommitInspector } from "../../pages/workspace/CommitInspector";
import { WorkspaceDiffPanel } from "../../pages/workspace/WorkspaceDiffPanel";
import { ariaShortcut, resetZoom, THEME_CYCLE, zoomIn, zoomOut } from "../../features/settings";
import { getRepositoryDisplayName } from "../../shared/lib/repository-display-name";
import { isComposerVisible } from "../../features/commits";
import { DETAILS_WIDTH } from "../../features/repositories";
import { CommitActionsMenu, isFullGitObjectId, type CommitFileNavigation, type CommitWorkflowAction } from "../../features/history";
import { currentPipelineSource } from "../../features/pipelines";
import { CommitGraph } from "./lazy-views";

import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";
import type { DiffArea } from "./use-app-diff";
import type { Work } from "./use-app-work";
import type { Actions } from "./use-app-actions";

export function useAppViewModel(ctx: Shell & Connection & Repositories & DiffArea & Work & Actions) {
  const { setPipelineRunSource, activeBranches, activeDiffKey, activeStatus, activeStatusLoading, addDiffSelectionToCommit, amendCommit, apiRef, branchSwitcher, canCommit, changeWorkspaceMode, cloneSubmission, closeInspector, closeRepositoryTab, commitBusy, commitChanges, commitDescription, commitMessage, commitSummary, connected, copyCommitSha, detailsWidth, diffQuery, diffState, diffTarget, diffViewPreferences, fetchRepository, focusMode, hasActiveRepositoryTask, hasActiveStagingTask, hasConflicts, historyFileOid, historyFilePath, historyRequests, inspectorOverlay, isMacPlatform, mode, nextTheme, openCommitFileDiff, openDiffWindow, openExternally, openFileDiff, openPullDialog, openPushDialog, openTagEditor, page, refreshRepositoryStatus, rememberGraphScroll, repositoryOpening, requestDiscard, requestShelfComposer, reviewableFiles, selectCommit, selectedCommit, selectedFilePath, selectedRepository, setCommitAssistantOpen, setCommitMessage, setCompareRequest, setCreateBranchAt, setDetailsWidth, setFocusMode, setHistoryBranch, setLocalBranchAction, setPage, setReflogOpen, setSettingsView, setSidebarHidden, setSubmodulesOpen, setWorktreeFrom, shortcuts, shownHistoryBranch, stageChanges, stageSelectedChanges, stagedCount, stagingBusy, structureQuery, t, theme, toggleFocusMode, toggleInspector, toggleSidebar, undoRecentOperation, updateDiffViewPreferences, workflowDialog, workingCount, workspaceSession } = ctx;

  const commands = createPaletteCommands({
    t,
    shortcuts,
    isMacPlatform,
    page: page === "welcome" ? "welcome" : "workspace",
    mode: mode === "history" ? "history" : "changes",
    connected,
    repository: selectedRepository
      ? { repoId: selectedRepository.repoId, availability: selectedRepository.availability, head: selectedRepository.head, branch: selectedRepository.branch, detached: selectedRepository.detached }
      : undefined,
    hasActiveRepositoryTask,
    hasBranches: Boolean(activeBranches),
    pipelineSource: currentPipelineSource(activeBranches),
    stagedCount,
    workingCount,
    hasConflicts,
    commitBusy,
    canCommit,
    hasCommitMessage: Boolean(commitSummary.trim()),
    selectedCommit: isFullGitObjectId(selectedCommit) ? selectedCommit : undefined,
    hasDiffTarget: Boolean(diffTarget),
    hasSelectedFile: Boolean(selectedFilePath),
    activeStatusLoading,
    themeDetail: t("cmd.themeDetail", { current: t(`theme.${theme}`), next: t(`theme.${THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]}`) }),
    run: {
      showWelcome: () => setPage("welcome"),
      showWorkspace: () => setPage("workspace"),
      openAppearance: () => setSettingsView({ section: "appearance" }),
      nextTheme,
      openRepository: () => { void repositoryOpening.chooseAndOpenLocal(); },
      initializeRepository: () => { void repositoryOpening.chooseAndInitializeLocal(); },
      cloneRepository: () => cloneSubmission.openDialog(),
      openBranchSwitcher: branchSwitcher.openSwitcher,
      createBranchAt: setCreateBranchAt,
      checkoutCommit: branchSwitcher.checkoutCommit,
      resetToCommit: (oid) => workflowDialog.openReset(oid),
      renameCurrentBranch: (name) => setLocalBranchAction({ name, mode: "rename" }),
      newWorktreeFrom: (oid) => setWorktreeFrom({ oid, label: oid.slice(0, 7) }),
      merge: (oid) => { if (selectedRepository) workflowDialog.open(selectedRepository.repoId, oid, "merge"); },
      cherryPick: (oid) => { if (selectedRepository) workflowDialog.open(selectedRepository.repoId, oid, "cherryPick"); },
      revert: (oid) => { if (selectedRepository) workflowDialog.open(selectedRepository.repoId, oid, "revert"); },
      createTag: openTagEditor,
      reset: () => workflowDialog.openReset(),
      rebase: workflowDialog.openRebase,
      fetch: () => { void fetchRepository(); },
      pull: () => openPullDialog(),
      push: () => openPushDialog(),
      commit: () => { void commitChanges("commit"); },
      commitAndPush: () => { void commitChanges("commitAndPush"); },
      stageAll: () => { void stageChanges("stageAll"); },
      undo: () => { void undoRecentOperation(); },
      refreshStatus: (repoId) => { void refreshRepositoryStatus(repoId, true); },
      openDiff: () => changeWorkspaceMode("changes"),
      searchCommits: (repoId) => {
        if (mode === "changes") changeWorkspaceMode("history");
        setFocusMode(false);
        historyRequests.focusSearch(repoId);
      },
      shelve: (repoId) => requestShelfComposer(repoId),
      openSettings: () => setSettingsView({}),
      openAiAssistant: () => setCommitAssistantOpen(true),
      showView: changeWorkspaceMode,
      toggleSidebar,
      toggleInspector,
      toggleFocusMode,
      toggleDiffView: () => updateDiffViewPreferences((current) => ({ sideBySide: !current.sideBySide })),
      zoomIn,
      zoomOut,
      zoomReset: resetZoom,
      showReflog: () => setReflogOpen(true),
      showSubmodules: () => setSubmodulesOpen(true),
      compare: setCompareRequest,
      runPipeline: (source) => setPipelineRunSource(source),
      openInEditor: () => { if (selectedRepository) void openExternally("editor", selectedRepository.repoId); },
      openInTerminal: () => { if (selectedRepository) void openExternally("terminal", selectedRepository.repoId); },
      manageRemotes: () => { changeWorkspaceMode("history"); setSidebarHidden("history", false); setFocusMode(false); },
      closeTab: closeRepositoryTab,
    },
  });

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
      loadLfsAvailability={apiRef.current ? () => apiRef.current!.getGitLfsStatus() : undefined}
      loadImage={apiRef.current && selectedRepository ? (side) => apiRef.current!.getRepositoryImage(selectedRepository.repoId, { path: target.path, scope: target.scope, side, ...(target.scope === "commit" && target.commitOid ? { commitOid: target.commitOid } : {}), ...(diffState.document?.originalPath ? { originalPath: diffState.document.originalPath } : {}) }) : undefined}
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
      return <div className="viewEmpty"><h2>{selectedRepository.head ? t("main.connectingHistory") : t("hv.noCommits")}</h2><p>{t("hv.noCommitsHint")}</p>{!selectedRepository.head && <button className="secondaryButton" type="button" onClick={() => changeWorkspaceMode("changes")}>{t("hv.openChanges")}</button>}</div>;
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
      onCompare={(target, workingTree) => setCompareRequest({ base: target, workingTree })}
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
  return { commands, composerVisible, currentBranch, inspectorSize, changesIndex, selectedReviewable, openReviewableFile, renderDiffPanel, renderCommitGraph, renderCommitActions, renderInspector, paletteContext };
}

export type ViewModel = ReturnType<typeof useAppViewModel>;
