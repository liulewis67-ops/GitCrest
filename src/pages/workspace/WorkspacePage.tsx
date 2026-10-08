import type { ReactNode } from "react";
import type { RepositoryResponse } from "../../api/client";
import type { ShortcutPreferences } from "../../features/settings";
import type { WorkspaceMode } from "../../features/repositories";
import { ariaShortcut, displayShortcut } from "../../features/settings";

interface WorkspacePageProps {
  selectedRepository?: RepositoryResponse;
  selectedFilePath?: string;
  mode: WorkspaceMode;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  connected: boolean;
  connecting: boolean;
  version?: string;
  hasActiveRepositoryTask: boolean;
  pushDisabledReason: string;
  pullDisabledReason: string;
  children: ReactNode;
  onChangeWorkspaceMode: (mode: WorkspaceMode) => void;
  onOpenPushDialog: () => void;
  onOpenPullDialog: () => void;
  onFetchRepository: () => void;
  onOpenBranchSwitcher: () => void;
}

export function WorkspacePage({
  selectedRepository,
  selectedFilePath,
  mode,
  shortcuts,
  isMacPlatform,
  connected,
  connecting,
  version,
  hasActiveRepositoryTask,
  pushDisabledReason,
  pullDisabledReason,
  children,
  onChangeWorkspaceMode,
  onOpenPushDialog,
  onOpenPullDialog,
  onFetchRepository,
  onOpenBranchSwitcher,
}: WorkspacePageProps) {
  return (
    <section className="workspacePage" aria-label="Git workspace">
      <div className="workspaceToolbar">
        <div className="workspaceCrumb"><span className="crumbMark" aria-hidden="true">G</span><span>Workspace</span><span className="crumbSlash">/</span><span className="mutedText">{selectedRepository?.path || "No repository open"}</span></div>
        <div className="toolbarActions">
          <button className={mode === "graph" ? "modeButton active" : "modeButton"} type="button" onClick={() => onChangeWorkspaceMode("graph")}>Graph</button>
          <button className={mode === "diff" ? "modeButton active" : "modeButton"} type="button" disabled={!selectedFilePath} aria-keyshortcuts={ariaShortcut(shortcuts.openDiff, isMacPlatform)} title={!selectedFilePath ? "Select a changed file to open Diff" : `Open the selected file diff (${displayShortcut(shortcuts.openDiff, isMacPlatform)})`} onClick={() => onChangeWorkspaceMode("diff")}>Diff</button>
          <span className="toolbarDivider" />
          <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} aria-keyshortcuts={ariaShortcut(shortcuts.push, isMacPlatform)} title={pushDisabledReason || `Preview the current branch push (${displayShortcut(shortcuts.push, isMacPlatform)})`} onClick={onOpenPushDialog}>Push</button>
          <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} title={pullDisabledReason || `Review worktree state, then pull with merge or rebase (${displayShortcut(shortcuts.pull, isMacPlatform)})`} onClick={onOpenPullDialog}>Pull</button>
          <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} aria-keyshortcuts={ariaShortcut(shortcuts.fetch, isMacPlatform)} title={selectedRepository ? `Fetch from configured remotes (${displayShortcut(shortcuts.fetch, isMacPlatform)})` : "Open a repository to fetch"} onClick={onFetchRepository}>Fetch</button>
          <span className="toolbarDivider" />
          <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available"} title={selectedRepository ? `Switch branches (${displayShortcut(shortcuts.branchSwitcher, isMacPlatform)})` : "Open a repository to switch branches"} onClick={onOpenBranchSwitcher}><span className="branchGlyph" aria-hidden="true">⑂</span> {selectedRepository ? selectedRepository.detached ? `Detached · ${selectedRepository.head?.slice(0, 7)}` : selectedRepository.branch || "Unborn branch" : "No branch"}</button>
        </div>
      </div>

      {children}
      <footer className="statusbar"><span className="statusIcon" aria-hidden="true">●</span>{connected ? "Git engine ready" : connecting ? "Connecting to Git engine" : "Git engine unavailable"}<span className="statusbarDivider" /><span>{version || "API v1"}</span><span className="footerSpacer" /><span>Repository actions planned for S1</span></footer>
    </section>
  );
}

export default WorkspacePage;
