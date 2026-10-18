import { lazy, Suspense } from "react";
import type { BranchSnapshotResponse, GitCrestApiClient, RemoteSnapshotResponse, RepositoryResponse, StagingRequest, StatusSnapshotResponse, TaskSnapshotResponse } from "../../api/client";
import type { RepositoryStatusGroup } from "../../features/changes";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { loadRemoteManager } from "../../features/remotes";
import { BranchSyncBadge, WorktreeList } from "../../features/branches";
import type { CredentialEditorRenderer } from "../../features/credentials";

const RemoteManager = lazy(() => loadRemoteManager().then(({ RemoteManager }) => ({ default: RemoteManager })));
const ShelfCenter = lazy(() => import("../../features/shelves").then(({ ShelfCenter }) => ({ default: ShelfCenter })));

type ShelfAfterCreateAction = { switchTarget: string; existingShelfIds: string[] };
type ShelfSwitchState = { repoId: string; target: string; existingShelfIds: string[] };

interface WorkspaceNavigationProps {
  selectedRepository?: RepositoryResponse;
  activeStatus?: StatusSnapshotResponse;
  activeStatusError?: string;
  activeStatusLoading: boolean;
  statusGroups: RepositoryStatusGroup[];
  workingCount: number;
  stagedCount: number;
  stagingBusy: boolean;
  hasActiveStagingTask: boolean;
  selectedFilePath?: string;
  selectedFileScope?: "workingTree" | "index" | "commit";
  activeBranches?: BranchSnapshotResponse;
  hasBranchSnapshot: boolean;
  activeBranchError?: string;
  activeBranchesLoading: boolean;
  orderedBranches: BranchSnapshotResponse["branches"];
  activeRemotes?: RemoteSnapshotResponse;
  activeRemoteError?: string;
  activeRemotesLoading: boolean;
  remoteActionBusy: boolean;
  remoteDisabledReason: string;
  api?: GitCrestApiClient;
  renderCredentialEditor: CredentialEditorRenderer;
  credentialManagerOpenRequest: number;
  historyRefreshKey: number;
  shelfComposerRequest: number;
  shelfComposerAfterSwitch?: ShelfSwitchState;
  connected: boolean;
  connecting: boolean;
  hasActiveRepositoryTask: boolean;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  onStageChanges: (action: StagingRequest["action"], path?: string) => void;
  onRefreshRepositoryStatus: (repoId: string, forceRefresh?: boolean) => void;
  onRefreshRepositoryBranches: (repoId: string) => void;
  onOpenFileDiff: (path: string, scope: "workingTree" | "index") => void;
  onDeleteRemoteBranch: (branchRef: string) => void;
  onSwitchBranch: (name: string) => void;
  onMergeBranch: (oid: string) => void;
  onOpenWorktree: (path: string) => void;
  onWorktreeRemoveStarted: (task: TaskSnapshotResponse) => void;
  onManageBranch: (name: string, mode: "rename" | "delete") => void;
  onToggleBranchFavorite: (fullName: string, favorite: boolean) => void;
  onFetchRepository: () => void;
  onRefreshRepositoryRemotes: (repoId: string) => void;
  onAddRepositoryRemote: (name: string, url: string) => void;
  onSetRepositoryRemoteUrl: (name: string, url: string) => void;
  onDeleteRepositoryRemote: (name: string) => void;
  onSetRepositoryDefaultRemote: (name: string | null) => void;
  onSetRepositoryBranchUpstream: (localBranch: string, remoteName: string, remoteBranch: string) => void;
  onShelfTaskSubmitted: (task?: TaskSnapshotResponse, afterCreate?: ShelfAfterCreateAction) => void;
  onShelfComposerClosed: () => void;
}

function changeCode(kind: StatusSnapshotResponse["files"][number]["kind"]): string {
  return ({ modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", typeChanged: "T", untracked: "?", ignored: "!", conflicted: "U" })[kind];
}

export function WorkspaceNavigation(props: WorkspaceNavigationProps) {
  const {
    selectedRepository, activeStatus, activeStatusError, activeStatusLoading, statusGroups,
    workingCount, stagedCount, stagingBusy, hasActiveStagingTask, selectedFilePath, selectedFileScope,
    activeBranches, hasBranchSnapshot, activeBranchError, activeBranchesLoading, orderedBranches,
    activeRemotes, activeRemoteError, activeRemotesLoading, remoteActionBusy, remoteDisabledReason,
    api, renderCredentialEditor, credentialManagerOpenRequest, historyRefreshKey, shelfComposerRequest, shelfComposerAfterSwitch,
    connected, connecting, hasActiveRepositoryTask, shortcuts, isMacPlatform,
    onStageChanges: stageChanges, onRefreshRepositoryStatus: refreshRepositoryStatus,
    onRefreshRepositoryBranches: refreshRepositoryBranches, onOpenFileDiff: openFileDiff,
    onDeleteRemoteBranch, onSwitchBranch, onMergeBranch, onOpenWorktree, onWorktreeRemoveStarted, onManageBranch, onToggleBranchFavorite: toggleBranchFavorite, onFetchRepository: fetchRepository,
    onRefreshRepositoryRemotes: refreshRepositoryRemotes, onAddRepositoryRemote: addRepositoryRemote,
    onSetRepositoryRemoteUrl: setRepositoryRemoteUrl, onDeleteRepositoryRemote: deleteRepositoryRemote,
    onSetRepositoryDefaultRemote: setRepositoryDefaultRemote, onSetRepositoryBranchUpstream: setRepositoryBranchUpstream,
    onShelfTaskSubmitted, onShelfComposerClosed,
  } = props;
  return (            <aside className="navigationPanel" aria-label="Repository navigation">
              <div className="panelHeading"><span>REPOSITORY</span><button className="panelMenu" type="button" disabled aria-label="Repository options">···</button></div>
              <div className="navGroup changesNavigation">
                <div className="navGroupTitle changesHeading"><span>Changes</span><span className="countBadge">{activeStatus ? activeStatus.files.length : "—"}</span></div>
                <div className="changeGroupActions">
                  <button type="button" disabled={!activeStatus || workingCount === 0 || activeStatus.files.some((file) => file.kind === "conflicted") || stagingBusy || hasActiveStagingTask} aria-keyshortcuts={ariaShortcut(shortcuts.stageAll, isMacPlatform)} title={`Stage all changes (${displayShortcut(shortcuts.stageAll, isMacPlatform)})`} onClick={() => void stageChanges("stageAll")}>Stage all</button>
                  <button type="button" disabled={!activeStatus || stagedCount === 0 || activeStatus.files.some((file) => file.kind === "conflicted") || stagingBusy || hasActiveStagingTask} onClick={() => void stageChanges("unstageAll")}>Unstage all</button>
                </div>
                {!selectedRepository && <div className="navEmpty">No repository open</div>}
                {selectedRepository && !activeStatus && activeStatusLoading && <div className="navEmpty" role="status">Loading working tree status…</div>}
                {selectedRepository && !activeStatus && activeStatusError && <div className="statusLoadError" role="alert"><span>{activeStatusError}</span><button type="button" onClick={() => void refreshRepositoryStatus(selectedRepository.repoId, true)}>Retry</button></div>}
                {activeStatus && activeStatus.files.length === 0 && <div className="navEmpty">Working tree clean</div>}
                {activeStatus && activeStatusError && <div className="statusStaleNotice" role="status">Refresh failed. Showing the last snapshot.</div>}
                {statusGroups.filter((group) => group.files.length > 0).map((group) => (
                  <section className="changeGroup" key={group.category} aria-label={`${group.label} changes`}>
                    <div className="changeGroupTitle"><span>{group.label}</span><span>{group.files.length}</span></div>
                    {group.files.map((file) => (
                      <div className="statusFileRow" key={`${group.category}:${file.path}`}>
                        <button className={`statusFileItem statusFileButton${selectedFilePath === file.path && selectedFileScope === (group.category === "staged" ? "index" : "workingTree") ? " selected" : ""}`} type="button" aria-label={`${file.kind} ${file.path}`} aria-pressed={selectedFilePath === file.path && selectedFileScope === (group.category === "staged" ? "index" : "workingTree")} title={file.originalPath ? `${file.originalPath} → ${file.path}` : `Review ${file.path}`} onClick={() => openFileDiff(file.path, group.category === "staged" ? "index" : "workingTree")}>
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
                      <BranchSyncBadge branch={branch} />
                      {!branch.isCurrent && !branch.fullName.endsWith("/HEAD") && <span className="branchActions">
                        {branch.kind === "local" && <button className="branchAction" type="button" aria-label={`Switch to ${branch.name}`} title={`Switch to ${branch.name}`} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClick={() => onSwitchBranch(branch.name)}>Switch</button>}
                        <button className="branchAction" type="button" aria-label={`Merge ${branch.fullName} into the current branch`} title={`Merge ${branch.name} into the current branch`} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClick={() => onMergeBranch(branch.oid)}>Merge</button>
                        {branch.kind === "local" && <button className="branchAction" type="button" aria-label={`Rename ${branch.name}`} title={`Rename ${branch.name}`} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClick={() => onManageBranch(branch.name, "rename")}>Rename</button>}
                        {branch.kind === "local" && <button className="branchAction" type="button" aria-label={`Delete ${branch.name}`} title={`Delete ${branch.name}`} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClick={() => onManageBranch(branch.name, "delete")}>Delete</button>}
                      </span>}
                      {branch.kind === "remote" && !branch.fullName.endsWith("/HEAD") && <button className="branchRemoteDelete" type="button" aria-label={"Delete remote branch " + branch.fullName} title={"Delete remote branch " + branch.fullName} disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} onClick={() => onDeleteRemoteBranch(branch.fullName)}>×</button>}
                      <button className={`branchFavorite${branch.isFavorite ? " active" : ""}`} type="button" aria-label={`${branch.isFavorite ? "Remove" : "Add"} ${branch.fullName} ${branch.isFavorite ? "from" : "to"} favorites`} aria-pressed={branch.isFavorite} onClick={() => void toggleBranchFavorite(branch.fullName, branch.isFavorite)}>{branch.isFavorite ? "★" : "☆"}</button>
                    </li>
                  ))}
                </ul>}
              </div>
              {selectedRepository && api && <WorktreeList api={api} repoId={selectedRepository.repoId} refreshKey={historyRefreshKey} disabled={!connected || hasActiveRepositoryTask} onOpen={onOpenWorktree} onRemoveStarted={onWorktreeRemoveStarted} />}
              <div className="navDivider" />
              <Suspense fallback={<div className="navEmpty" role="status" aria-live="polite">Loading remote controls…</div>}><RemoteManager
                snapshot={activeRemotes}
                branches={activeBranches}
                renderCredentialEditor={renderCredentialEditor}
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
              /></Suspense>
              {selectedRepository && api ? <Suspense fallback={<div className="navGroup"><div className="navGroupTitle">Shelves</div><div className="navEmpty" role="status" aria-live="polite">Loading shelves…</div></div>}><ShelfCenter
                key={selectedRepository.repoId}
                api={api}
                repoId={selectedRepository.repoId}
                headOid={selectedRepository.head}
                files={activeStatus?.files || []}
                statusReady={Boolean(activeStatus)}
                disabled={!connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask}
                refreshKey={historyRefreshKey}
                openComposerRequest={shelfComposerRequest}
                afterCreateAction={shelfComposerAfterSwitch ? { switchTarget: shelfComposerAfterSwitch.target, existingShelfIds: shelfComposerAfterSwitch.existingShelfIds } : undefined}
                onTaskSubmitted={onShelfTaskSubmitted}
                onComposerClosed={onShelfComposerClosed}
              /></Suspense> : <div className="navGroup"><div className="navGroupTitle">Shelves</div><div className="navEmpty">Open a repository to manage shelves</div></div>}
              <div className="panelFooter"><span className="statusIcon" aria-hidden="true">●</span> {connected ? "Engine ready" : connecting ? "Connecting to engine" : "Engine unavailable"}</div>
            </aside>
  );
}

export default WorkspaceNavigation;
