import { useI18n } from "../../shared/i18n";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { BranchSnapshotResponse, RepositoryResponse } from "../../api/client";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { WORKSPACE_MODES, type WorkspaceMode } from "../../features/repositories";

type Branch = BranchSnapshotResponse["branches"][number];

interface WorkspacePageProps {
  repository?: RepositoryResponse;
  mode: WorkspaceMode;
  /** Files in the working tree status, shown on the Changes tab. */
  changedFileCount?: number;
  conflictCount: number;
  /** The checked-out local branch, for incoming and outgoing counts. */
  currentBranch?: Branch;
  /** Undefined until the remotes are read. */
  remoteCount?: number;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  pushDisabledReason: string;
  pullDisabledReason: string;
  sidebarVisible: boolean;
  /** History and Branches have a commit inspector; Changes does not. */
  inspectorAvailable: boolean;
  inspectorOpen: boolean;
  focusMode: boolean;
  openingRepository: boolean;
  /** The worktree picker drawn before the branch; it draws nothing when there are no linked worktrees. */
  worktreeSwitcher?: ReactNode;
  children: ReactNode;
  onChangeMode: (mode: WorkspaceMode) => void;
  onOpenPushDialog: () => void;
  onOpenPullDialog: () => void;
  onFetchRepository: () => void;
  onOpenBranchSwitcher: () => void;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenTasks: () => void;
  onCreateBranchAtHead: () => void;
  /** The branch this repository was on before a commit was checked out, if known. */
  returnBranch?: string;
  onReturnToBranch?: (name: string) => void;
  onOpenRepository: () => void;
}

const VIEW_LABEL = { changes: "view.changes", history: "view.history" } as const;
const VIEW_TITLE = { changes: "view.changesTitle", history: "view.historyTitle" } as const;
const VIEW_SHORTCUT = { changes: "viewChanges", history: "viewHistory" } as const;
const VIEW_ICON = {
  changes: <><path d="M9.5 2.5H4.75a1.25 1.25 0 0 0-1.25 1.25v8.5a1.25 1.25 0 0 0 1.25 1.25h6.5a1.25 1.25 0 0 0 1.25-1.25V5.5Z" /><path d="M9.5 2.5v3h3" /><path d="M8 7.25v3.5M6.25 9h3.5" /></>,
  history: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.25l2.25 1.25" /></>,
} as const;
const STATE_LABEL = { merging: "state.merging", rebasing: "state.rebasing", cherryPicking: "state.cherryPicking", bisecting: "state.bisecting" } as const;

export function WorkspacePage({
  repository,
  mode,
  changedFileCount,
  conflictCount,
  currentBranch,
  remoteCount,
  shortcuts,
  isMacPlatform,
  connected,
  hasActiveRepositoryTask,
  pushDisabledReason,
  pullDisabledReason,
  sidebarVisible,
  inspectorAvailable,
  inspectorOpen,
  focusMode,
  openingRepository,
  worktreeSwitcher,
  children,
  onChangeMode,
  onOpenPushDialog,
  onOpenPullDialog,
  onFetchRepository,
  onOpenBranchSwitcher,
  onToggleSidebar,
  onToggleInspector,
  onOpenTasks,
  onCreateBranchAtHead,
  returnBranch,
  onReturnToBranch,
  onOpenRepository,
}: WorkspacePageProps) {
  const { t } = useI18n();
  const tabRefs = useRef<Partial<Record<WorkspaceMode, HTMLButtonElement | null>>>({});

  if (!repository) {
    return (
      <section className="workspacePage" aria-label={t("page.aria")}>
        <div className="workspaceEmpty">
          <h2>{t("main.graphStartsHere")}</h2>
          <p>{t("main.openToExplore")}</p>
          <button className="secondaryButton" type="button" onClick={() => onOpenRepository()} disabled={openingRepository}>{t("main.openRepository")} <span aria-hidden="true">→</span></button>
        </div>
      </section>
    );
  }

  const repositoryReady = connected && repository.availability === "available";
  const remoteActionsDisabled = !repositoryReady || hasActiveRepositoryTask;
  const ahead = currentBranch?.ahead ?? 0;
  const behind = currentBranch?.behind ?? 0;
  const operation = repository.state !== "normal" ? repository.state : undefined;
  const sidebarLabel = sidebarVisible ? t("panel.hideSidebar") : t("panel.showSidebar");
  const inspectorLabel = inspectorOpen ? t("panel.hideDetails") : t("panel.showDetails");

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % WORKSPACE_MODES.length
      : event.key === "ArrowLeft" ? (index - 1 + WORKSPACE_MODES.length) % WORKSPACE_MODES.length
        : event.key === "Home" ? 0
          : event.key === "End" ? WORKSPACE_MODES.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    const target = WORKSPACE_MODES[next];
    onChangeMode(target);
    tabRefs.current[target]?.focus();
  }

  return (
    <section className={`workspacePage${focusMode ? " focusMode" : ""}`} aria-label={t("page.aria")}>
      {!focusMode && <div className="workspaceToolbar">
        <div className="viewSwitcher" role="tablist" aria-label={t("view.navAria")}>
          {WORKSPACE_MODES.map((view, index) => (
            <button
              key={view}
              ref={(node) => { tabRefs.current[view] = node; }}
              className={view === mode ? "viewTab active" : "viewTab"}
              type="button"
              role="tab"
              id={`workspace-tab-${view}`}
              aria-selected={view === mode}
              aria-controls="workspace-view"
              tabIndex={view === mode ? 0 : -1}
              aria-keyshortcuts={ariaShortcut(shortcuts[VIEW_SHORTCUT[view]], isMacPlatform)}
              title={t(VIEW_TITLE[view], { shortcut: displayShortcut(shortcuts[VIEW_SHORTCUT[view]], isMacPlatform) })}
              onClick={() => onChangeMode(view)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              <svg className="viewTabIcon" viewBox="0 0 16 16" aria-hidden="true">{VIEW_ICON[view]}</svg>
              <span>{t(VIEW_LABEL[view])}</span>
              {view === "changes" && Boolean(changedFileCount) && <span className={`viewTabCount${conflictCount ? " conflicted" : ""}`} aria-label={t("view.changedFiles", { count: changedFileCount ?? 0 })}>{changedFileCount}</span>}
            </button>
          ))}
        </div>
        <div className="workspaceCrumb" title={repository.path}><svg className="workspaceCrumbIcon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.25c0-.69.56-1.25 1.25-1.25h2.5l1.5 1.5h4.5c.69 0 1.25.56 1.25 1.25v5.5c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25Z" /></svg><span className="mutedText">{repository.path}</span></div>
        <div className="toolbarActions">
          {worktreeSwitcher}
          <button className={`quietButton compact branchSelector${repository.detached ? " detached" : ""}`} type="button" disabled={!repositoryReady} aria-keyshortcuts={ariaShortcut(shortcuts.branchSwitcher, isMacPlatform)} title={t("page.switchBranches", { shortcut: displayShortcut(shortcuts.branchSwitcher, isMacPlatform) })} onClick={() => onOpenBranchSwitcher()}>
            <span className="branchGlyph" aria-hidden="true">⑂</span>
            <span className="branchSelectorName">{repository.detached ? t("page.detached", { oid: repository.head?.slice(0, 7) ?? "" }) : repository.branch || t("page.unbornBranch")}</span>
            <span className="branchSelectorCaret" aria-hidden="true">▾</span>
          </button>
          {remoteCount === 0 ? <span className="syncNoRemotes" title={t("sync.noRemotesTitle")}>{t("sync.noRemotes")}</span> : <div className="syncGroup" role="group" aria-label={t("sync.aria")}>
            <button className="syncButton" type="button" disabled={remoteActionsDisabled} aria-keyshortcuts={ariaShortcut(shortcuts.fetch, isMacPlatform)} title={t("page.fetchTitle", { shortcut: displayShortcut(shortcuts.fetch, isMacPlatform) })} onClick={() => onFetchRepository()}>{t("page.fetch")}</button>
            <button className="syncButton" type="button" disabled={remoteActionsDisabled} aria-label={t("page.pull")} aria-keyshortcuts={ariaShortcut(shortcuts.pull, isMacPlatform)} title={pullDisabledReason || [behind > 0 ? t("sync.incoming", { count: behind }) : "", t("page.pullTitle", { shortcut: displayShortcut(shortcuts.pull, isMacPlatform) })].filter(Boolean).join(" · ")} onClick={() => onOpenPullDialog()}>{t("page.pull")}{behind > 0 && <span className="syncCount" aria-hidden="true">↓{behind}</span>}</button>
            <button className="syncButton" type="button" disabled={remoteActionsDisabled} aria-label={t("page.push")} aria-keyshortcuts={ariaShortcut(shortcuts.push, isMacPlatform)} title={pushDisabledReason || [ahead > 0 ? t("sync.outgoing", { count: ahead }) : "", t("page.pushTitle", { shortcut: displayShortcut(shortcuts.push, isMacPlatform) })].filter(Boolean).join(" · ")} onClick={() => onOpenPushDialog()}>{t("page.push")}{ahead > 0 && <span className="syncCount" aria-hidden="true">↑{ahead}</span>}</button>
          </div>}
          <span className="toolbarDivider" aria-hidden="true" />
          <button className={`quietButton compact iconButton panelToggle${sidebarVisible ? " active" : ""}`} type="button" aria-pressed={sidebarVisible} aria-label={sidebarLabel} aria-keyshortcuts={ariaShortcut(shortcuts.toggleSidebar, isMacPlatform)} title={t("panel.sidebarTitle", { shortcut: displayShortcut(shortcuts.toggleSidebar, isMacPlatform) })} onClick={() => onToggleSidebar()}><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M6 2.5v11" />{sidebarVisible && <path className="fill" d="M2.5 3.5h3v9h-3z" />}</svg></button>
          {inspectorAvailable && <button id="inspector-toggle" className={`quietButton compact iconButton panelToggle${inspectorOpen ? " active" : ""}`} type="button" aria-pressed={inspectorOpen} aria-label={inspectorLabel} aria-keyshortcuts={ariaShortcut(shortcuts.toggleInspector, isMacPlatform)} title={t("panel.detailsTitle", { shortcut: displayShortcut(shortcuts.toggleInspector, isMacPlatform) })} onClick={() => onToggleInspector()}><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M10 2.5v11" />{inspectorOpen && <path className="fill" d="M10.5 3.5h3v9h-3z" />}</svg></button>}
        </div>
      </div>}
      {(operation || conflictCount > 0) && <div className="workspaceBanner" role="status">
        <strong>{operation ? t(STATE_LABEL[operation]) : t(conflictCount === 1 ? "state.conflictsOne" : "state.conflictsMany", { count: conflictCount })}</strong>
        <span>{operation && conflictCount > 0 ? `${t(conflictCount === 1 ? "state.conflictsOne" : "state.conflictsMany", { count: conflictCount })} · ` : ""}{operation ? t("state.operationHint") : t("state.conflictHint")}</span>
        <span className="workspaceBannerSpacer" />
        {conflictCount > 0 && mode !== "changes" && <button className="secondaryButton compact" type="button" onClick={() => onChangeMode("changes")}>{t("state.reviewConflicts")}</button>}
        {operation && <button className="secondaryButton compact" type="button" onClick={() => onOpenTasks()}>{t("state.openTasks")}</button>}
      </div>}
      {!focusMode && repository.detached && mode === "changes" && !operation && <div className="workspaceBanner subtle" role="status">
        <strong>{t("state.detached", { oid: repository.head?.slice(0, 7) ?? "" })}</strong>
        <span>{t("state.detachedHint")}</span>
        <span className="workspaceBannerSpacer" />
        <button className="secondaryButton compact" type="button" disabled={!repositoryReady || hasActiveRepositoryTask || !repository.head} onClick={() => onCreateBranchAtHead()}>{t("state.createBranch")}</button>
        {returnBranch && onReturnToBranch && <button className="secondaryButton compact" type="button" disabled={!repositoryReady || hasActiveRepositoryTask} onClick={() => onReturnToBranch?.(returnBranch)}>{t("state.returnToBranch", { name: returnBranch })}</button>}
      </div>}
      <div className="workspaceView" id="workspace-view" role="tabpanel" aria-labelledby={`workspace-tab-${mode}`}>
        {children}
      </div>
    </section>
  );
}

export default WorkspacePage;
