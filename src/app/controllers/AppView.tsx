import { Suspense } from "react";
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
  const { activeBranchError, activeBranchesLoading, activeRemotes, activeStatus, apiRef, branchSwitchShelfFlow, branchSwitcher, changeWorkspaceMode, checkForUpdates, cloneSubmission, closeRepositoryTab, closeSettings, commandKey, commands, conflictCount, connected, connectionState, currentBranch, fetchRepository, focusMode, forgetRepository, hasActiveRepositoryTask, hasBranchSnapshot, historyRequests, inspectorVisible, installUpdate, isMacPlatform, mode, openError, openPullDialog, openPushDialog, orderedBranches, page, paletteContext, paletteOpen, paletteQuery, pullDisabledReason, pushDisabledReason, repositories, repositoryOpening, restartCore, reviewableFiles, selectedRepository, setCreateBranchAt, setPage, setPaletteOpen, setPaletteQuery, setSettingsView, setShortcuts, setTasksOpen, settingsView, shortcuts, showCommitComposer, sidebarVisible, status, t, tasks, toggleFavorite, toggleInspector, toggleSidebar, updateStatus, version, workspaceSession } = ctx;
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
          onForgetRepository={(repository) => void forgetRepository(repository)}
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
          hasActiveRepositoryTask={hasActiveRepositoryTask}
          pushDisabledReason={pushDisabledReason}
          pullDisabledReason={pullDisabledReason}
          sidebarVisible={sidebarVisible}
          inspectorAvailable={mode !== "changes"}
          inspectorOpen={inspectorVisible}
          focusMode={focusMode}
          openingRepository={repositoryOpening.opening}
          worktreeSwitcher={selectedRepository && apiRef.current ? <WorktreeSwitcher
            api={apiRef.current}
            repoId={selectedRepository.repoId}
            refreshKey={historyRequests.refreshKey}
            disabled={!connected || repositoryOpening.opening}
            onOpen={(path) => void repositoryOpening.openAtPath(path)}
          /> : undefined}
          onChangeMode={changeWorkspaceMode}
          onOpenPushDialog={openPushDialog}
          onOpenPullDialog={openPullDialog}
          onFetchRepository={() => void fetchRepository()}
          onOpenBranchSwitcher={branchSwitcher.openSwitcher}
          onToggleSidebar={toggleSidebar}
          onToggleInspector={toggleInspector}
          onOpenTasks={() => setTasksOpen(true)}
          returnBranch={(selectedRepository ? branchSwitcher.returnBranches[selectedRepository.repoId] : undefined)}
          onReturnToBranch={(name) => { branchSwitcher.openSwitcher(); void branchSwitcher.inspect(name); }}
          onCreateBranchAtHead={() => { if (isFullGitObjectId(selectedRepository?.head)) setCreateBranchAt(selectedRepository.head); }}
          onOpenRepository={() => void repositoryOpening.chooseAndOpenLocal()}
        >
          <ChangesView ctx={ctx} />

          <HistoryView ctx={ctx} />
        </WorkspacePage>
      )}

      {settingsView && apiRef.current && <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">{t("load.dialog")}</div>}>
          <SettingsPage api={apiRef.current} repoId={selectedRepository?.repoId} initialSection={settingsView.section} credentialHosts={settingsView.credentialHosts} onClose={closeSettings} shortcuts={shortcuts} onShortcutsChange={setShortcuts} updateStatus={updateStatus} onCheckForUpdates={checkForUpdates} onInstallUpdate={installUpdate} />
        </Suspense>}

      {branchSwitcher.open && <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">{t("load.branchSwitcher")}</div>}>
          <BranchSwitcherDialog
            repository={selectedRepository}
            branchSwitcher={branchSwitcher}
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
        navigationShortcut={commandKey}
        query={paletteQuery}
        onQueryChange={setPaletteQuery}
        onClose={() => setPaletteOpen(false)}
      />

      <AppDialogs ctx={ctx} />
    </main>
  );
}
