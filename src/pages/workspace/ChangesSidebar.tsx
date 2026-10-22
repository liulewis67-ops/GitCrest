import { lazy, Suspense } from "react";
import type { GitCrestApiClient, RepositoryResponse, StagingRequest, StatusSnapshotResponse, TaskSnapshotResponse } from "../../api/client";
import type { RepositoryStatusGroup } from "../../features/changes";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { useI18n } from "../../shared/i18n";

const ShelfCenter = lazy(() => import("../../features/shelves").then(({ ShelfCenter }) => ({ default: ShelfCenter })));

type ShelfAfterCreateAction = { switchTarget: string; existingShelfIds: string[] };
type ShelfSwitchState = { repoId: string; target: string; existingShelfIds: string[] };

export function changeCode(kind: StatusSnapshotResponse["files"][number]["kind"]): string {
  return ({ modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", typeChanged: "T", untracked: "?", ignored: "!", conflicted: "U" })[kind];
}

export function groupScope(category: RepositoryStatusGroup["category"]): "workingTree" | "index" {
  return category === "staged" ? "index" : "workingTree";
}

interface ChangesSidebarProps {
  repository: RepositoryResponse;
  api?: GitCrestApiClient;
  status?: StatusSnapshotResponse;
  statusError?: string;
  statusLoading: boolean;
  statusGroups: RepositoryStatusGroup[];
  workingCount: number;
  stagedCount: number;
  hasConflicts: boolean;
  stagingBusy: boolean;
  hasActiveStagingTask: boolean;
  selectedFilePath?: string;
  selectedFileScope?: "workingTree" | "index";
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  historyRefreshKey: number;
  shelfComposerRequest: number;
  shelfComposerAfterSwitch?: ShelfSwitchState;
  onStageChanges: (action: StagingRequest["action"], path?: string) => void;
  onRefreshStatus: (repoId: string, forceRefresh?: boolean) => void;
  onOpenFileDiff: (path: string, scope: "workingTree" | "index") => void;
  onShelfTaskSubmitted: (task?: TaskSnapshotResponse, afterCreate?: ShelfAfterCreateAction) => void;
  onShelfComposerClosed: () => void;
  onShelfComposerRequestHandled: () => void;
}

/** Changed files grouped by staged, unstaged, untracked and conflicted, plus the shelves they can be put aside in. */
export function ChangesSidebar({
  repository, api, status, statusError, statusLoading, statusGroups, workingCount, stagedCount, hasConflicts,
  stagingBusy, hasActiveStagingTask, selectedFilePath, selectedFileScope, connected, hasActiveRepositoryTask,
  shortcuts, isMacPlatform, historyRefreshKey, shelfComposerRequest, shelfComposerAfterSwitch,
  onStageChanges, onRefreshStatus, onOpenFileDiff, onShelfTaskSubmitted, onShelfComposerClosed, onShelfComposerRequestHandled,
}: ChangesSidebarProps) {
  const { t } = useI18n();
  const stagingBlocked = !status || hasConflicts || stagingBusy || hasActiveStagingTask;
  const canStageAll = workingCount > 0 && !stagingBlocked;
  const canUnstageAll = stagedCount > 0 && !stagingBlocked;
  return (
    <aside className="sidePanel changesSidebar" aria-label={t("chg.aria")}>
      <div className="sidePanelHeader">
        <span className="sidePanelTitle">{t("nav.changes")}</span>
        <span className="countBadge" aria-label={status ? t("view.changedFiles", { count: status.files.length }) : undefined}>{status ? status.files.length : "—"}</span>
        <span className="sidePanelSpacer" />
        <button className="quietButton compact iconButton" type="button" disabled={statusLoading} onClick={() => onRefreshStatus(repository.repoId, true)} aria-keyshortcuts={ariaShortcut(shortcuts.refreshStatus, isMacPlatform)} aria-label={statusLoading ? t("main.refreshingLabel") : t("main.refreshLabel")} title={statusLoading ? t("main.refreshingLabel") : t("main.refreshTitle", { shortcut: displayShortcut(shortcuts.refreshStatus, isMacPlatform) })}><span className={statusLoading ? "spinGlyph" : undefined} aria-hidden="true">↻</span></button>
      </div>
      {/* Only the bulk actions that apply right now; a clean tree shows none. */}
      {status && (workingCount > 0 || stagedCount > 0) && <div className="sidePanelActions">
        {workingCount > 0 && <button className="quietButton compact" type="button" disabled={!canStageAll} aria-keyshortcuts={ariaShortcut(shortcuts.stageAll, isMacPlatform)} title={t("nav.stageAllTitle", { shortcut: displayShortcut(shortcuts.stageAll, isMacPlatform) })} onClick={() => onStageChanges("stageAll")}>{t("nav.stageAll")}</button>}
        {stagedCount > 0 && <button className="quietButton compact" type="button" disabled={!canUnstageAll} onClick={() => onStageChanges("unstageAll")}>{t("nav.unstageAll")}</button>}
      </div>}
      <div className="sidePanelScroll">
        {!status && statusLoading && <p className="sidebarNotice" role="status">{t("nav.loadingStatus")}</p>}
        {!status && statusError && <div className="statusLoadError" role="alert"><span>{statusError}</span><button type="button" onClick={() => onRefreshStatus(repository.repoId, true)}>{t("nav.retry")}</button></div>}
        {status && statusError && <div className="statusStaleNotice" role="status">{t("nav.staleStatus")}</div>}
        {statusGroups.filter((group) => group.files.length > 0).map((group) => (
          <section className={`changeGroup group-${group.category}`} key={group.category} aria-label={t("nav.groupAria", { label: t(`grp.${group.category}`) })}>
            <div className="changeGroupTitle"><span>{t(`grp.${group.category}`)}</span><span>{group.files.length}</span></div>
            {group.files.map((file) => {
              const scope = groupScope(group.category);
              const selected = selectedFilePath === file.path && selectedFileScope === scope;
              const slash = file.path.lastIndexOf("/");
              return (
                <div className={`statusFileRow${selected ? " selected" : ""}`} key={`${group.category}:${file.path}`}>
                  <button className={`statusFileItem statusFileButton${selected ? " selected" : ""}`} type="button" aria-label={`${file.kind} ${file.path}`} aria-pressed={selected} title={file.originalPath ? `${file.originalPath} → ${file.path}` : t("nav.review", { path: file.path })} onClick={() => onOpenFileDiff(file.path, scope)}>
                    <span className={`statusFileCode status-${file.kind}`} aria-label={file.kind}>{changeCode(file.kind)}</span>
                    <span className="statusFilePath">{slash >= 0 && <span className="statusFileDirectory">{file.path.slice(0, slash + 1)}</span>}<span className="statusFileName">{file.path.slice(slash + 1)}</span></span>
                    {file.modeChanged && <span className="modeChangedTag" title={t("nav.modeChanged")}>{t("nav.mode")}</span>}
                  </button>
                  <button
                    className="statusFileStageAction"
                    type="button"
                    disabled={stagingBusy || hasActiveStagingTask || file.kind === "conflicted" || group.category === "ignored" || group.category === "conflicted"}
                    aria-label={group.category === "staged" ? t("nav.unstageFile", { path: file.path }) : t("nav.stageFile", { path: file.path })}
                    title={file.kind === "conflicted" ? t("nav.resolveFirst") : group.category === "staged" ? t("nav.unstageThis") : t("nav.stageThis")}
                    onClick={() => onStageChanges(group.category === "staged" ? "unstageFile" : "stageFile", file.path)}
                  >{group.category === "staged" ? "−" : "+"}</button>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      {api ? <Suspense fallback={<div className="navGroup shelfSection"><div className="navGroupTitle">{t("nav.shelves")}</div><div className="navEmpty" role="status" aria-live="polite">{t("nav.loadingShelves")}</div></div>}><div className="shelfSection"><ShelfCenter
        key={repository.repoId}
        api={api}
        repoId={repository.repoId}
        headOid={repository.head}
        files={status?.files || []}
        statusReady={Boolean(status)}
        disabled={!connected || repository.availability !== "available" || hasActiveRepositoryTask}
        refreshKey={historyRefreshKey}
        openComposerRequest={shelfComposerRequest}
        afterCreateAction={shelfComposerAfterSwitch ? { switchTarget: shelfComposerAfterSwitch.target, existingShelfIds: shelfComposerAfterSwitch.existingShelfIds } : undefined}
        onTaskSubmitted={onShelfTaskSubmitted}
        onComposerClosed={onShelfComposerClosed}
        onComposerRequestHandled={onShelfComposerRequestHandled}
      /></div></Suspense> : null}
    </aside>
  );
}
