import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { GitCrestApiClient, RepositoryResponse, StagingRequest, StatusSnapshotResponse, TaskSnapshotResponse } from "../../api/client";
import type { ChangeTreeFile, ChangeTreeGroup } from "../../features/changes";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { useI18n } from "../../shared/i18n";

const ShelfCenter = lazy(() => import("../../features/shelves").then(({ ShelfCenter }) => ({ default: ShelfCenter })));

type ShelfAfterCreateAction = { switchTarget: string; existingShelfIds: string[] };
type ShelfSwitchState = { repoId: string; target: string; existingShelfIds: string[] };
type DiffScope = "workingTree" | "index";
export type CommitPanelTab = "commit" | "shelves";

export function changeCode(kind: StatusSnapshotResponse["files"][number]["kind"]): string {
  return ({ modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", typeChanged: "T", untracked: "?", ignored: "!", conflicted: "U" })[kind];
}

const GROUP_LABEL = { conflicts: "cp.conflicts", changes: "cp.changes", unversioned: "cp.unversioned", ignored: "cp.ignored" } as const;

function Checkbox({ checked, indeterminate, disabled, label, title, onToggle }: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  label: string;
  title?: string;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  return <input ref={ref} className="treeCheckbox" type="checkbox" checked={checked} disabled={disabled} aria-label={label} title={title} onChange={onToggle} />;
}

function Icon({ name }: { name: "refresh" | "shelve" | "expand" | "collapse" | "stageAll" | "unstageAll" }) {
  const paths = {
    refresh: <><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M13 3v2.5h-2.5" /></>,
    shelve: <><path d="M2.5 9.5v3h11v-3" /><path d="M8 2.5v7" /><path d="m5 6.5 3 3 3-3" /></>,
    expand: <><path d="m5 6 3-3 3 3" /><path d="m5 10 3 3 3-3" /></>,
    collapse: <><path d="m5 3 3 3 3-3" /><path d="m5 13 3-3 3 3" /></>,
    stageAll: <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M8 5.5v5M5.5 8h5" /></>,
    unstageAll: <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8h5" /></>,
  };
  return <svg className="toolbarIcon" viewBox="0 0 16 16" aria-hidden="true">{paths[name]}</svg>;
}

interface CommitPanelProps {
  repository: RepositoryResponse;
  api?: GitCrestApiClient;
  status?: StatusSnapshotResponse;
  statusError?: string;
  statusLoading: boolean;
  tree: ChangeTreeGroup[];
  workingCount: number;
  stagedCount: number;
  hasConflicts: boolean;
  stagingBusy: boolean;
  hasActiveStagingTask: boolean;
  selectedFilePath?: string;
  selectedFileScope?: DiffScope;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  tab: CommitPanelTab;
  historyRefreshKey: number;
  shelfComposerRequest: number;
  shelfComposerAfterSwitch?: ShelfSwitchState;
  /** The commit form, drawn below the file tree. */
  composer?: ReactNode;
  onTabChange: (tab: CommitPanelTab) => void;
  onStageChanges: (action: StagingRequest["action"], target?: string | string[]) => void;
  onRefreshStatus: (repoId: string, forceRefresh?: boolean) => void;
  onOpenFileDiff: (path: string, scope: DiffScope) => void;
  onShelve: () => void;
  onShelfTaskSubmitted: (task?: TaskSnapshotResponse, afterCreate?: ShelfAfterCreateAction) => void;
  onShelfComposerClosed: () => void;
  onShelfComposerRequestHandled: () => void;
}

/**
 * The Commit tool window of the Changes view: tracked changes and unversioned files in one
 * tree, a checkbox per file that stages or unstages it, and the commit form underneath.
 * A second tab holds the shelves.
 */
export function CommitPanel({
  repository, api, status, statusError, statusLoading, tree, workingCount, stagedCount, hasConflicts,
  stagingBusy, hasActiveStagingTask, selectedFilePath, selectedFileScope, connected, hasActiveRepositoryTask,
  shortcuts, isMacPlatform, tab, historyRefreshKey, shelfComposerRequest, shelfComposerAfterSwitch, composer,
  onTabChange, onStageChanges, onRefreshStatus, onOpenFileDiff, onShelve, onShelfTaskSubmitted, onShelfComposerClosed, onShelfComposerRequestHandled,
}: CommitPanelProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<ChangeTreeGroup["id"]>>(() => new Set(["ignored"]));
  const stagingBlocked = !status || stagingBusy || hasActiveStagingTask;
  // Whole-tree actions are refused while a conflict is unresolved; single files stay stageable.
  const bulkBlocked = stagingBlocked || hasConflicts;
  const visibleGroups = tree.filter((group) => group.files.length > 0);
  const filesLabel = (count: number) => t(count === 1 ? "cp.filesOne" : "cp.filesMany", { count });

  function toggleGroup(id: ChangeTreeGroup["id"]) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleFile({ file, stage }: ChangeTreeFile) {
    onStageChanges(stage === "staged" ? "unstageFile" : "stageFile", file.path);
  }

  function toggleGroupFiles(files: ChangeTreeFile[]) {
    if (files.every(({ stage }) => stage === "staged")) {
      onStageChanges("unstagePaths", files.map(({ file }) => file.path));
    } else {
      onStageChanges("stagePaths", files.filter(({ stage }) => stage !== "staged").map(({ file }) => file.path));
    }
  }

  function fileRow(group: ChangeTreeGroup["id"], entry: ChangeTreeFile) {
    const { file, stage, scopes } = entry;
    const selected = selectedFilePath === file.path;
    const slash = file.path.lastIndexOf("/");
    const checkable = group === "changes" || group === "unversioned";
    const openScope = selected && selectedFileScope && scopes.includes(selectedFileScope) ? selectedFileScope : scopes[0];
    return (
      <li className={`changeTreeRow${selected ? " selected" : ""}`} key={file.path}>
        {checkable ? <Checkbox
          checked={stage === "staged"}
          indeterminate={stage === "partial"}
          disabled={stagingBlocked}
          label={t("nav.stageFile", { path: file.path })}
          title={stage === "partial" ? t("cp.partial") : stage === "staged" ? t("nav.unstageThis") : t("nav.stageThis")}
          onToggle={() => toggleFile(entry)}
        /> : <span className="treeCheckboxSpacer" aria-hidden="true" />}
        <button
          className="changeTreeFile"
          type="button"
          aria-label={`${file.kind} ${file.path}`}
          aria-pressed={selected}
          title={file.originalPath ? `${file.originalPath} → ${file.path}` : t("nav.review", { path: file.path })}
          onClick={() => onOpenFileDiff(file.path, openScope)}
        >
          <span className={`statusFileCode status-${file.kind}`} aria-label={file.kind}>{changeCode(file.kind)}</span>
          <span className={`changeTreeName status-${file.kind}`}>{file.path.slice(slash + 1)}</span>
          {slash >= 0 && <span className="changeTreeDirectory">{file.path.slice(0, slash)}</span>}
          {stage === "partial" && <span className="changeTreeTag">{t("cp.partialTag")}</span>}
          {file.modeChanged && <span className="modeChangedTag" title={t("nav.modeChanged")}>{t("nav.mode")}</span>}
        </button>
      </li>
    );
  }

  return (
    <aside className="sidePanel commitPanel" aria-label={t("chg.aria")}>
      <div className="commitPanelTabs" role="tablist" aria-label={t("cp.tabsAria")}>
        {(["commit", "shelves"] as const).map((id) => (
          <button key={id} type="button" role="tab" id={`commit-panel-tab-${id}`} aria-selected={tab === id} aria-controls={`commit-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? "commitPanelTab active" : "commitPanelTab"} onClick={() => onTabChange(id)} onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = id === "commit" ? "shelves" : "commit";
            onTabChange(next);
            requestAnimationFrame(() => document.getElementById(`commit-panel-tab-${next}`)?.focus());
          }}>{id === "commit" ? t("cp.commitTab") : t("nav.shelves")}</button>
        ))}
      </div>

      {tab === "commit" ? <div className="commitPanelBody" id="commit-panel-commit" role="tabpanel" aria-labelledby="commit-panel-tab-commit">
        <div className="commitPanelToolbar" role="toolbar" aria-label={t("cp.toolbar")}>
          <button className="quietButton compact iconButton" type="button" disabled={statusLoading} onClick={() => onRefreshStatus(repository.repoId, true)} aria-keyshortcuts={ariaShortcut(shortcuts.refreshStatus, isMacPlatform)} aria-label={statusLoading ? t("main.refreshingLabel") : t("main.refreshLabel")} title={statusLoading ? t("main.refreshingLabel") : t("main.refreshTitle", { shortcut: displayShortcut(shortcuts.refreshStatus, isMacPlatform) })}><span className={statusLoading ? "spinGlyph" : undefined}><Icon name="refresh" /></span></button>
          <button className="quietButton compact iconButton" type="button" disabled={!status || workingCount === 0 || bulkBlocked} aria-keyshortcuts={ariaShortcut(shortcuts.stageAll, isMacPlatform)} aria-label={t("nav.stageAll")} title={t("nav.stageAllTitle", { shortcut: displayShortcut(shortcuts.stageAll, isMacPlatform) })} onClick={() => onStageChanges("stageAll")}><Icon name="stageAll" /></button>
          <button className="quietButton compact iconButton" type="button" disabled={!status || stagedCount === 0 || bulkBlocked} aria-label={t("nav.unstageAll")} title={t("nav.unstageAll")} onClick={() => onStageChanges("unstageAll")}><Icon name="unstageAll" /></button>
          <button className="quietButton compact iconButton" type="button" disabled={!connected || repository.availability !== "available" || hasActiveRepositoryTask} aria-keyshortcuts={ariaShortcut(shortcuts.shelve, isMacPlatform)} aria-label={t("cp.shelve")} title={t("cp.shelveTitle", { shortcut: displayShortcut(shortcuts.shelve, isMacPlatform) })} onClick={onShelve}><Icon name="shelve" /></button>
          <span className="toolbarDivider" aria-hidden="true" />
          <button className="quietButton compact iconButton" type="button" disabled={visibleGroups.length === 0} aria-label={t("cp.expandAll")} title={t("cp.expandAll")} onClick={() => setCollapsed(new Set())}><Icon name="expand" /></button>
          <button className="quietButton compact iconButton" type="button" disabled={visibleGroups.length === 0} aria-label={t("cp.collapseAll")} title={t("cp.collapseAll")} onClick={() => setCollapsed(new Set(tree.map((group) => group.id)))}><Icon name="collapse" /></button>
        </div>
        <div className="changeTree">
          {!status && statusLoading && <p className="sidebarNotice" role="status">{t("nav.loadingStatus")}</p>}
          {!status && statusError && <div className="statusLoadError" role="alert"><span>{statusError}</span><button type="button" onClick={() => onRefreshStatus(repository.repoId, true)}>{t("nav.retry")}</button></div>}
          {status && statusError && <div className="statusStaleNotice" role="status">{t("nav.staleStatus")}</div>}
          {status && visibleGroups.length === 0 && <p className="sidebarNotice">{t("cp.noChanges")}</p>}
          {visibleGroups.map((group) => {
            const label = t(GROUP_LABEL[group.id]);
            const open = !collapsed.has(group.id);
            const checkable = group.id === "changes" || group.id === "unversioned";
            const allStaged = group.files.every(({ stage }) => stage === "staged");
            const someStaged = group.files.some(({ stage }) => stage !== "unstaged");
            return (
              <section className={`changeTreeGroup group-${group.id}`} key={group.id} aria-label={label}>
                <div className="changeTreeGroupRow">
                  <button className="treeToggle" type="button" aria-expanded={open} aria-label={open ? t("cp.collapseGroup", { group: label }) : t("cp.expandGroup", { group: label })} onClick={() => toggleGroup(group.id)}><span aria-hidden="true">{open ? "▾" : "▸"}</span></button>
                  {checkable ? <Checkbox
                    checked={allStaged}
                    indeterminate={someStaged && !allStaged}
                    disabled={stagingBlocked}
                    label={t("cp.groupCheck", { group: label })}
                    onToggle={() => toggleGroupFiles(group.files)}
                  /> : <span className="treeCheckboxSpacer" aria-hidden="true" />}
                  <button className="changeTreeGroupName" type="button" tabIndex={-1} onClick={() => toggleGroup(group.id)}>{label}</button>
                  <span className="changeTreeGroupCount">{filesLabel(group.files.length)}</span>
                </div>
                {open && <ul>{group.files.map((entry) => fileRow(group.id, entry))}</ul>}
              </section>
            );
          })}
        </div>
        {composer}
      </div> : null}

      {/* Mounted only with its tab: a shelf request switches here first, so the composer dialog is never inside a hidden panel. */}
      {tab === "shelves" && api ? <div className="commitPanelBody shelvesBody" id="commit-panel-shelves" role="tabpanel" aria-labelledby="commit-panel-tab-shelves">
        <Suspense fallback={<div className="navEmpty" role="status" aria-live="polite">{t("nav.loadingShelves")}</div>}><ShelfCenter
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
        /></Suspense>
      </div> : null}
    </aside>
  );
}
