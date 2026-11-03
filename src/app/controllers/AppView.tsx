import { Suspense, useState } from "react";
import type { RepositoryResponse } from "../../api/client";
import { isRepositoryReadFailure, RepositoryRecoveryPanel, RepositoryRemoveDialog } from "../../features/repositories";
import { requireGitCrestBridge } from "../../api/bridge";
import { AppTitlebar } from "../layouts/AppTitlebar";
import { CommandPalette } from "../layouts/CommandPalette";
import { WelcomePage } from "../../pages/welcome/WelcomePage";
import { WorkspacePage } from "../../pages/workspace/WorkspacePage";
import { ariaShortcut, displayShortcut } from "../../features/settings";
import { isFullGitObjectId } from "../../features/history";
import { WorktreeSwitcher } from "../../features/branches";
import { SettingsPage, BranchSwitcherDialog } from "./lazy-views";
import type { AppContext } from "./app-context";
import { AppDialogs } from "./AppDialogs";
import { ChangesView } from "./ChangesView";
import { HistoryView } from "./HistoryView";
import { InPlacePipelineBanner } from "../../features/pipelines";

export function AppView({ ctx }: { ctx: AppContext }) {
  const [removeCandidate, setRemoveCandidate] = useState<RepositoryResponse>();
  const { repositoryReadable, repositoryReadError, repositoryReadErrors } = ctx;
  const { activeBranchError, activeBranchesLoading, activeRemotes, activeStatus, apiRef, branchSwitchShelfFlow, branchSwitcher, changeWorkspaceMode, checkForUpdates, cloneSubmission, closeRepositoryTab, closeSettings, commands, conflictCount, connected, connectionState, currentBranch, fetchRepository, fetchAllRemotes, focusMode, forgetRepository, hasActiveRepositoryTask, hasBranchSnapshot, historyRequests, inspectorVisible, installUpdate, isMacPlatform, mode, openError, openPullDialog, openPushDialog, orderedBranches, page, paletteContext, paletteOpen, paletteQuery, pullDisabledReason, pushDisabledReason, repositories, repositoryOpening, restartCore, reviewableFiles, selectedRepository, setCreateBranchAt, setPage, setPaletteOpen, setPaletteQuery, setSettingsView, setShortcuts, setTasksOpen, settingsView, shortcuts, showCommitComposer, sidebarVisible, status, t, tasks, toggleFavorite, toggleInspector, toggleSidebar, updateStatus, version, workspaceSession } = ctx;
  const historyError = selectedRepository ? ctx.historyReadErrors[selectedRepository.repoId] : undefined;
  const showRepositoryRecovery = selectedRepository && (selectedRepository.availability !== "available"
    || isRepositoryReadFailure(ctx.activeStatusError) || (mode === "changes" && isRepositoryReadFailure(historyError)));
  return (
    <main className="appShell">
      <AppTitlebar
        page={page}
        openRepoIds={workspaceSession.openRepoIds}
        repositories={repositories}
        selectedRepository={selectedRepository}
        shortcuts={shortcuts}
        status={status}
        connected={connected}
        connecting={connectionState === "connecting"}
        onRestartCore={() => void restartCore()}
        activeTaskCount={tasks.filter((task) => task.status === "queued" || task.status === "running").length}
        isMacPlatform={isMacPlatform}
        openingRepository={repositoryOpening.opening}
        onPageChange={(nextPage) => { setSettingsView(undefined); setPage(nextPage); }}
        onSelectRepository={(repository) => { setSettingsView(undefined); void repositoryOpening.openRecent(repository); }}
        onCloseRepository={closeRepositoryTab}
        onOpenLocalRepository={() => void repositoryOpening.chooseAndOpenLocal()}
        onCloneRepository={() => cloneSubmission.openDialog()}
        onInitializeRepository={() => void repositoryOpening.chooseAndInitializeLocal()}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onOpenTasks={() => setTasksOpen(true)}
        onOpenSettings={() => setSettingsView((open) => open ? undefined : {})}
      />

      <div className="appPageContent" data-settings-background>
      <InPlacePipelineBanner repoId={selectedRepository?.repoId} />

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
          onForgetRepository={(repository) => { closeRepositoryTab(repository.repoId); void forgetRepository(repository); }}
          onLocateRepository={(repository) => void repositoryOpening.locateRecent(repository)}
          readErrors={repositoryReadErrors}
        />
      ) : (
        <WorkspacePage
          repository={selectedRepository}
          mode={mode}
          changedFileCount={activeStatus ? reviewableFiles.length : undefined}
          conflictCount={conflictCount}
          currentBranch={currentBranch}
          remoteCount={activeRemotes && Array.isArray(activeRemotes.remotes) ? activeRemotes.remotes.length : undefined}
          shortcuts={shortcuts}
          isMacPlatform={isMacPlatform}
          connected={connected}
          repositoryUnavailable={Boolean(selectedRepository && !repositoryReadable)}
          hasActiveRepositoryTask={hasActiveRepositoryTask}
          pushDisabledReason={pushDisabledReason}
          pullDisabledReason={pullDisabledReason}
          sidebarVisible={sidebarVisible}
          inspectorAvailable={mode !== "changes"}
          inspectorOpen={inspectorVisible}
          focusMode={focusMode && repositoryReadable}
          openingRepository={repositoryOpening.opening}
          worktreeSwitcher={selectedRepository && apiRef.current ? <WorktreeSwitcher
            api={apiRef.current}
            repoId={selectedRepository.repoId}
            refreshKey={historyRequests.refreshKey}
            disabled={!connected || repositoryOpening.opening}
            repositoryPath={selectedRepository.path}
            onNewWorktree={() => { if (selectedRepository.head) ctx.setWorktreeFrom({ oid: selectedRepository.head, label: selectedRepository.branch ?? selectedRepository.head.slice(0, 7) }); }}
            onNewWorktreeFrom={(oid, label) => ctx.setWorktreeFrom({ oid, label })}
            onRemove={ctx.setRemoveWorktreePath}
            onReveal={ctx.revealFile}
            onTaskStarted={ctx.prependTask}
            onOpen={(path) => void repositoryOpening.openAtPath(path)}
          /> : undefined}
          onChangeMode={changeWorkspaceMode}
          onOpenPushDialog={openPushDialog}
          onOpenPullDialog={openPullDialog}
          onFetchRepository={() => void fetchRepository()}
          onFetchAllRemotes={() => void fetchAllRemotes()}
          onOpenBranchSwitcher={() => { if (branchSwitcher.open) branchSwitcher.close(); else branchSwitcher.openSwitcher(); }}
          onToggleSidebar={toggleSidebar}
          onToggleInspector={toggleInspector}
          onOpenTasks={() => setTasksOpen(true)}
          onResolveConflicts={() => { if (selectedRepository) void ctx.openRepositoryConflicts(selectedRepository.repoId); }}
          returnBranch={(selectedRepository ? branchSwitcher.returnBranches[selectedRepository.repoId] : undefined)}
          onReturnToBranch={(name) => { branchSwitcher.openSwitcher(); void branchSwitcher.inspect(name); }}
          onCreateBranchAtHead={() => { if (isFullGitObjectId(selectedRepository?.head)) setCreateBranchAt(selectedRepository.head); }}
          onOpenRepository={() => void repositoryOpening.chooseAndOpenLocal()}
        >
          {selectedRepository && showRepositoryRecovery ? <RepositoryRecoveryPanel
            repository={selectedRepository}
            error={openError || repositoryReadError}
            busy={repositoryOpening.opening || !connected}
            onLocate={() => void repositoryOpening.locateRecent(selectedRepository)}
            onRemove={() => setRemoveCandidate(selectedRepository)}
            onRetry={() => {
              void repositoryOpening.openAtPath(selectedRepository.path);
              void ctx.refreshRepositoryStatus(selectedRepository.repoId, true);
              if (apiRef.current) void ctx.refreshRepositories(apiRef.current);
              if (isRepositoryReadFailure(historyError)) changeWorkspaceMode("history");
              historyRequests.refresh();
            }}
          /> : <><ChangesView ctx={ctx} /><HistoryView ctx={ctx} renderHistoryError={(error, retry) => selectedRepository && isRepositoryReadFailure(error) ? <RepositoryRecoveryPanel repository={selectedRepository} error={error} busy={repositoryOpening.opening || !connected} onLocate={() => void repositoryOpening.locateRecent(selectedRepository)} onRemove={() => setRemoveCandidate(selectedRepository)} onRetry={retry} /> : undefined} /></>}
        </WorkspacePage>
      )}

      </div>

      {removeCandidate && <RepositoryRemoveDialog repository={removeCandidate} busy={!connected} onClose={() => setRemoveCandidate(undefined)} onConfirm={() => { closeRepositoryTab(removeCandidate.repoId); void forgetRepository(removeCandidate); setRemoveCandidate(undefined); setPage("welcome"); }} />}

      {settingsView && apiRef.current && <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">{t("load.dialog")}</div>}>
          <SettingsPage api={apiRef.current} repoId={selectedRepository?.repoId} initialSection={settingsView.section} credentialHosts={settingsView.credentialHosts} onClose={closeSettings} shortcuts={shortcuts} onShortcutsChange={setShortcuts} updateStatus={updateStatus} onCheckForUpdates={checkForUpdates} onInstallUpdate={installUpdate} />
        </Suspense>}

      {branchSwitcher.open && <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">{t("load.branchSwitcher")}</div>}>
          <BranchSwitcherDialog
            repository={selectedRepository}
            branchSwitcher={branchSwitcher}
            anchored
            onChanged={() => { void ctx.refreshRepositoryBranches(selectedRepository!.repoId); historyRequests.refresh(); }}
            onTaskStarted={ctx.prependTask}
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
              showCommitComposer();
            }}
            onShelveAndSwitch={() => void branchSwitchShelfFlow.openShelfComposerForBranchSwitch()}
            remoteCount={activeRemotes?.remotes.length}
            fetching={tasks.some((task) => task.repoId === selectedRepository?.repoId && task.operation.startsWith("fetch") && ["queued", "running"].includes(task.status))}
            onFetchAllRemotes={() => { branchSwitcher.setError(""); void fetchAllRemotes({ onTaskAccepted: (task) => { ctx.appendTask(task); ctx.setTasksError(""); }, onError: branchSwitcher.setError }); }}
            actions={{
              onSwitchBranch: (name) => { void branchSwitcher.inspect(name); },
              onCheckoutRemoteBranch: (name) => { void branchSwitcher.inspect(name, true); },
              onOpenWorktree: (path) => { branchSwitcher.close(); void repositoryOpening.openAtPath(path); },
              onMergeBranch: (oid, name) => { branchSwitcher.close(); ctx.workflowDialog.open(selectedRepository!.repoId, oid, "merge", name); },
              onRebaseOnto: (oid) => { branchSwitcher.close(); ctx.workflowDialog.openRebaseOnto(oid); },
              onCreateBranchFrom: (oid) => { branchSwitcher.close(); setCreateBranchAt(oid); },
              onNewWorktreeForBranch: (name, fromRemote) => { branchSwitcher.close(); ctx.setWorktreeForBranch({ name, fromRemote }); },
              onNewWorktreeFrom: (oid, label) => { branchSwitcher.close(); ctx.setWorktreeFrom({ oid, label }); },
              onManageBranch: (name, mode) => { branchSwitcher.close(); ctx.setLocalBranchAction({ name, mode }); },
              onRemoveWorktree: (path) => { branchSwitcher.close(); ctx.setRemoveWorktreePath(path); },
              onDeleteRemoteBranch: (ref) => { branchSwitcher.close(); ctx.remoteBranchDelete.open(ref); },
              onRunPipeline: (source) => { branchSwitcher.close(); ctx.setPipelineRunSource({ branch: source.name, oid: source.oid }); },
              onCompareRef: (name) => { branchSwitcher.close(); ctx.setCompareRequest({ base: name }); },
              onCopyBranchName: (name) => { void ctx.copyBranchName(name); },
              onShowHistory: (branch) => {
                branchSwitcher.close(); changeWorkspaceMode("history");
                ctx.setHistoryBranch({ repoId: selectedRepository!.repoId, fullName: branch.fullName });
                if (isFullGitObjectId(branch.oid)) ctx.selectCommit(branch.oid);
              },
              onToggleFavorite: (branch) => { void ctx.toggleBranchFavorite(selectedRepository!.repoId, branch.fullName, branch.isFavorite); },
              onPush: () => { branchSwitcher.close(); openPushDialog(); },
              onPull: () => { branchSwitcher.close(); openPullDialog(); },
              pushDisabledReason,
              pullDisabledReason,
            }}
            onChooseWorktreeParent={() => requireGitCrestBridge().chooseCloneParent()}
            onOpenWorktree={(path) => void repositoryOpening.openAtPath(path)}
            api={apiRef.current}
          />
        </Suspense>}

      <CommandPalette
        open={paletteOpen}
        context={paletteContext}
        commands={commands}
        shortcuts={shortcuts}
        isMacPlatform={isMacPlatform}
        query={paletteQuery}
        onQueryChange={setPaletteQuery}
        onClose={() => setPaletteOpen(false)}
      />

      <AppDialogs ctx={ctx} />
    </main>
  );
}
