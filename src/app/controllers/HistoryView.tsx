import { Suspense } from "react";
import { getGitCrestBridge } from "../../api/bridge";
import { BranchesSidebar } from "../../pages/workspace/BranchesSidebar";
import { ViewLayout } from "../../pages/workspace/ViewLayout";
import { HistorySplit } from "../../pages/workspace/HistorySplit";
import { COMMIT_FILES_WIDTH, HISTORY_GRAPH_HEIGHT, SIDEBAR_WIDTH } from "../../features/repositories";
import { isFullGitObjectId } from "../../features/history";
import { CommitChanges } from "./lazy-views";
import type { AppContext } from "./app-context";

export function HistoryView({ ctx }: { ctx: AppContext }) {
  const { openPullDialog, openPushDialog, pullDisabledReason, pushDisabledReason, setCompareRequest, activeBranchError, activeBranches, activeBranchesLoading, activeRemoteError, activeRemotes, activeRemotesLoading, apiRef, branchSwitcher, commitFilesWidth, connected, copyBranchName, diffTarget, focusMode, hasActiveRepositoryTask, historyFileOid, historyFilePath, historyGraphHeight, historyRequests, inspectorOverlay, inspectorSize, inspectorVisible, isMacPlatform, mode, openAccountSettings, openCommitFileDiff, openDiffWindow, openTagEditor, openWebUrl, orderedBranches, prependTask, refreshRepositoryBranches, refreshRepositoryRemotes, remoteBranchDelete, remoteDisabledReason, remoteMutations, renderCommitActions, renderCommitGraph, renderDiffPanel, renderInspector, repositoryOpening, revealFile, selectCommit, selectedCommit, selectedRepository, setCommitFilesWidth, setCreateBranchAt, setHistoryBranch, setHistoryGraphHeight, setLocalBranchAction, setRemoveWorktreePath, setSidebarWidth, setTasksError, setTasksOpen, setWorktreeForBranch, setWorktreeFrom, shortcuts, shownHistoryBranch, sidebarVisible, sidebarWidth, t, toggleBranchFavorite, workflowDialog } = ctx;
  return (
    <>
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
                selectedCommit={selectedCommit}
                onSelectCommit={selectCommit}
                onCreateTag={() => { const target = isFullGitObjectId(selectedCommit) ? selectedCommit : selectedRepository.head; if (isFullGitObjectId(target)) openTagEditor(target); }}
                onTagTaskStarted={(task) => { prependTask(task); setTasksError(""); setTasksOpen(true); }}
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
                onCompareRef={(name) => setCompareRequest({ base: name })}
                onOpenPushDialog={() => openPushDialog()}
                onOpenPullDialog={() => openPullDialog()}
                pushDisabledReason={pushDisabledReason}
                pullDisabledReason={pullDisabledReason}
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
                onOpenWebUrl={getGitCrestBridge()?.openExternalUrl ? openWebUrl : undefined}
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
    </>
  );
}
