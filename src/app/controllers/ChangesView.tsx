import { Icon as UiIcon } from "../../shared/ui/Icon";
import { ErrorMessage } from "../../shared/ui/ErrorMessage";
import { Suspense } from "react";
import { getGitCrestBridge } from "../../api/bridge";
import { CommitPanel, changeCode } from "../../pages/workspace/CommitPanel";
import { ViewLayout } from "../../pages/workspace/ViewLayout";
import { SIDEBAR_WIDTH } from "../../features/repositories";
import { CommitWorkbench } from "./lazy-views";
import type { AppContext } from "./app-context";

export function ChangesView({ ctx }: { ctx: AppContext }) {
  const { activeCommitAction, activeStatus, activeStatusError, activeStatusLoading, amendCommit, apiRef, branchSwitchShelfFlow, canCommit, changeTree, changeWorkspaceMode, changesIndex, chooseCommitAction, chooseCommitTemplate, commitActionIsDanger, commitActionLabel, commitActionMenuOpen, commitAssistantOpen, commitBusy, commitDescription, commitMessage, commitPanelTab, commitSelectionRepoId, commitSelections, commitSummary, commitTemplate, composerVisible, connected, diffTarget, gitIdentity, hasActiveRepositoryTask, hasActiveStagingTask, hasConflicts, historyRequests, identityMissing, inspectorSize, isMacPlatform, mode, openStashFile, openDiffWindow, openExternally, openFileDiff, openReviewableFile, prependTask, refreshRepositoryStatus, refreshTasks, renderDiffPanel, requestShelfComposer, revealFile, reviewableFiles, rollbackFile, runCommitAction, selectedDiffFile, selectedFilePath, selectedFileScope, selectedRepository, selectedReviewable, sensitiveStagedPaths, setAmendCommit, setCommitActionMenuOpen, setCommitAssistantOpen, setCommitDescription, setCommitMessage, setCommitPanelTab, setCommitSelections, setCommitSummary, setIgnoreRequest, setShelfComposerRequest, setSidebarWidth, setSignCommit, setSignOffCommit, shelfComposerRequest, shortcuts, showFileHistory, sidebarVisible, sidebarWidth, signCommit, signOffCommit, stageChanges, stagedCount, stagingBusy, t, workingCount } = ctx;
  return (
    <>
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
                    status={{ snapshot: activeStatus, stagedCount, workingCount, hasConflicts, sensitiveStagedPaths }}
                    commit={{ message: commitMessage, summary: commitSummary, description: commitDescription, template: commitTemplate, selections: commitSelections, selectionRepoId: commitSelectionRepoId, activeAction: activeCommitAction, actionLabel: commitActionLabel, actionIsDanger: commitActionIsDanger, actionMenuOpen: commitActionMenuOpen, assistantOpen: commitAssistantOpen, amend: amendCommit, signOff: signOffCommit, sign: signCommit, busy: commitBusy, canCommit }}
                    shortcuts={shortcuts}
                    isMacPlatform={isMacPlatform}
                    connected={connected}
                    hasActiveRepositoryTask={hasActiveRepositoryTask || stagingBusy}
                    api={apiRef.current}
                    identityMissing={identityMissing}
                    onIdentitySaved={() => void gitIdentity.refresh()}
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
                    onStageAll={() => void stageChanges("stageAll")}
                    onResolveConflicts={() => void ctx.openRepositoryConflicts(selectedRepository.repoId)}
                  />
                </Suspense> : undefined}
                onTabChange={setCommitPanelTab}
                onStageChanges={(action, target) => void stageChanges(action, target)}
                onRefreshStatus={(repoId, force) => void refreshRepositoryStatus(repoId, force)}
                onOpenFileDiff={openFileDiff}
                onOpenStashFile={openStashFile}
                onOpenShelfFile={ctx.openShelfFile}
                onCloseSavedFile={ctx.closeSavedFile}
                selectedSavedFile={ctx.openedSavedFile}
                onStashTaskSubmitted={(task) => {
                  prependTask(task);
                  void refreshTasks();
                }}
                onOpenInEditor={getGitCrestBridge()?.openInEditor ? (path) => void openExternally("editor", selectedRepository.repoId, path) : undefined}
                onIgnorePath={(path, ignoreMode) => setIgnoreRequest({ repoId: selectedRepository.repoId, path, mode: ignoreMode })}
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
              {diffTarget?.scope === "commit" ? renderDiffPanel(diffTarget, {})
                : commitPanelTab !== "commit" ? <div className="viewEmpty"><p>{t(commitPanelTab === "shelves" ? "sh.selectFile" : "stash.selectFile")}</p></div>
                : activeStatusError
                ? <div className="viewEmpty" role="alert"><p><ErrorMessage error={activeStatusError} /></p><button className="secondaryButton" type="button" onClick={() => void refreshRepositoryStatus(selectedRepository.repoId, true)}>{t("nav.retry")}</button></div>
                : !activeStatus ? <div className="viewEmpty" role="status"><span className="loadingSpinner" aria-hidden="true" /><p>{t("nav.loadingStatus")}</p></div>
                : reviewableFiles.length === 0 ? <div className="viewEmpty cleanState" role="status">
                  <span className="viewEmptyGlyph" aria-hidden="true"><UiIcon name="check" /></span>
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
    </>
  );
}
