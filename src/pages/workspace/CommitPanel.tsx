import { ErrorMessage } from "../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../shared/i18n/api-errors";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { GitCrestApiClient, RepositoryResponse, StagingRequest, StatusSnapshotResponse, TaskSnapshotResponse } from "../../api/client";
import type { ChangeTreeFile, ChangeTreeGroup, IgnoreMode } from "../../features/changes";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { useI18n } from "../../shared/i18n";
import { ContextMenu, type ContextMenuItem } from "../../shared/ui/ContextMenu";
import { InlineHint } from "../../shared/ui/InlineHint";

const ShelfCenter = lazy(() => import("../../features/shelves").then(({ ShelfCenter }) => ({ default: ShelfCenter })));
const StashList = lazy(() => import("../../features/shelves").then(({ StashList }) => ({ default: StashList })));

type ShelfAfterCreateAction = { switchTarget: string; existingShelfIds: string[] };
type ShelfSwitchState = { repoId: string; target: string; existingShelfIds: string[] };
type DiffScope = "workingTree" | "index";
const TABS = [
  { id: "commit", label: "cp.commitTab", bodyClass: "commitPanelBody" },
  { id: "shelves", label: "nav.shelves", bodyClass: "commitPanelBody shelvesBody" },
  { id: "stash", label: "stash.title", bodyClass: "commitPanelBody stashBody" },
] as const;
export type CommitPanelTab = (typeof TABS)[number]["id"];

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

function MenuIcon({ name }: { name: "diff" | "window" | "add" | "remove" | "shelve" | "rollback" | "history" | "copy" | "reveal" | "ignore" }) {
  const paths = {
    diff: <><path d="M5 2.5v7M1.5 6h7" /><path d="M8.5 12.5h6" /></>,
    window: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6h11" /></>,
    add: <path d="M8 3.5v9M3.5 8h9" />,
    remove: <path d="M3.5 8h9" />,
    shelve: <><path d="M2.5 9.5v3h11v-3" /><path d="M8 2.5v7" /><path d="m5 6.5 3 3 3-3" /></>,
    rollback: <><path d="M5.5 3.5 3 6l2.5 2.5" /><path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H7" /></>,
    history: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
    copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
    ignore: <><circle cx="8" cy="8" r="5.5" /><path d="m4.2 4.2 7.6 7.6" /></>,
    reveal: <path d="M2.5 4.5a1 1 0 0 1 1-1h3L8 5h4.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" />,
  };
  return <svg viewBox="0 0 16 16">{paths[name]}</svg>;
}

type FileMenu = { group: ChangeTreeGroup["id"]; entry: ChangeTreeFile; x: number; y: number; anchor: HTMLElement };

/** The file's path on disk, written with the separators of the repository's own path. */
export function absoluteFilePath(repositoryPath: string, path: string): string {
  const windows = /^[a-zA-Z]:[\\/]|^\\\\/.test(repositoryPath);
  const root = repositoryPath.replace(/[\\/]+$/, "");
  return windows ? `${root}/${path}`.replace(/\//g, "\\") : `${root}/${path}`;
}

interface CommitPanelProps {
  repository: RepositoryResponse;
  api?: GitCrestApiClient;
  status?: StatusSnapshotResponse;
  statusError?: DisplayError;
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
  shelfComposerPreselect?: { paths: string[]; scope: DiffScope };
  shelfComposerAfterSwitch?: ShelfSwitchState;
  /** The commit form, drawn below the file tree. */
  composer?: ReactNode;
  onTabChange: (tab: CommitPanelTab) => void;
  onStageChanges: (action: StagingRequest["action"], target?: string | string[]) => void;
  onRefreshStatus: (repoId: string, forceRefresh?: boolean) => void;
  onOpenFileDiff: (path: string, scope: DiffScope) => void;
  onOpenStashFile: (path: string, oid: string) => void;
  onOpenShelfFile?: (path: string, shelfId: string) => void;
  onCloseSavedFile?: () => void;
  selectedSavedFile?: { path: string; commitOid?: string };
  onStashTaskSubmitted: (task: TaskSnapshotResponse) => void;
  /** Right-click actions on a file; an item is left out of the menu when its handler is not given. */
  onOpenDiffWindow?: (path: string, scope: DiffScope) => void;
  onShelveFiles?: (paths: string[], scope: DiffScope) => void;
  onRollbackFile?: (path: string) => void;
  onShowFileHistory?: (path: string) => void;
  /** Opens the file in the chosen editor; left out when the desktop app is not available. */
  onOpenInEditor?: (path: string) => void;
  /** Starts adding an ignore rule for an untracked path; the caller shows the rule before writing it. */
  onIgnorePath?: (path: string, mode: IgnoreMode) => void;
  onRevealFile?: (absolutePath: string) => void;
  onShelve: () => void;
  onShelfTaskSubmitted: (task?: TaskSnapshotResponse, afterCreate?: ShelfAfterCreateAction) => void;
  onShelfComposerClosed: () => void;
  onShelfComposerRequestHandled: () => void;
}

/**
 * The Commit tool window of the Changes view: tracked changes and unversioned files in one
 * tree, a checkbox per file that stages or unstages it, and the commit form underneath.
 * The other tabs hold saved shelves and Git stashes.
 */
export function CommitPanel({
  repository, api, status, statusError, statusLoading, tree, workingCount, stagedCount, hasConflicts,
  stagingBusy, hasActiveStagingTask, selectedFilePath, selectedFileScope, connected, hasActiveRepositoryTask,
  shortcuts, isMacPlatform, tab, historyRefreshKey, shelfComposerRequest, shelfComposerPreselect, shelfComposerAfterSwitch, composer,
  onTabChange, onStageChanges, onRefreshStatus, onOpenFileDiff, onOpenStashFile, onStashTaskSubmitted, onOpenDiffWindow, onShelveFiles, onRollbackFile, onShowFileHistory, onOpenInEditor, onIgnorePath, onRevealFile, onShelve, onShelfTaskSubmitted, onShelfComposerClosed, onShelfComposerRequestHandled,
  onOpenShelfFile, onCloseSavedFile, selectedSavedFile,
}: CommitPanelProps) {
  const { t } = useI18n();
  const repositoryActionDisabled = !connected || repository.availability !== "available" || hasActiveRepositoryTask;
  const [collapsed, setCollapsed] = useState<ReadonlySet<ChangeTreeGroup["id"]>>(() => new Set(["ignored"]));
  const stagingBlocked = !status || stagingBusy || hasActiveStagingTask;
  // Whole-tree actions are refused while a conflict is unresolved; single files stay stageable.
  const bulkBlocked = stagingBlocked || hasConflicts;
  const visibleGroups = tree.filter((group) => group.files.length > 0);
  const filesLabel = (count: number) => t(count === 1 ? "cp.filesOne" : "cp.filesMany", { count });
  const [fileMenu, setFileMenu] = useState<FileMenu>();
  const changeTreeRef = useRef<HTMLDivElement>(null);
  const changeTreeScroll = useRef(0);
  const [checkedUnversioned, setCheckedUnversioned] = useState<ReadonlySet<string>>(() => new Set());
  const unversioned = tree.find((group) => group.id === "unversioned")?.files;
  const checkedPaths = unversioned?.filter(({ file }) => checkedUnversioned.has(file.path)).map(({ file }) => file.path) ?? [];
  const shelveBlocked = !connected || repository.availability !== "available" || hasActiveRepositoryTask;

  useLayoutEffect(() => {
    if (tab === "commit" && changeTreeRef.current) changeTreeRef.current.scrollTop = changeTreeScroll.current;
  }, [tab]);

  useEffect(() => {
    // Keep the selection during refreshes and failed staging. Drop paths once Git reports them staged or gone.
    if (!status) return;
    setCheckedUnversioned((current) => {
      if (!current.size) return current;
      const next = new Set(unversioned?.filter(({ file }) => current.has(file.path)).map(({ file }) => file.path));
      return next.size === current.size ? current : next;
    });
  }, [status, unversioned]);

  function toggleUnversioned(paths: string[]) {
    setCheckedUnversioned((current) => {
      const next = new Set(current);
      const clear = paths.every((path) => current.has(path));
      for (const path of paths) {
        if (clear) next.delete(path);
        else next.add(path);
      }
      return next;
    });
  }

  function addUnversioned(paths: string[]) {
    if (paths.length === 1) onStageChanges("stageFile", paths[0]);
    else if (paths.length > 1) onStageChanges("stagePaths", paths);
  }

  function toggleGroup(id: ChangeTreeGroup["id"]) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function changeTab(next: CommitPanelTab) {
    if (next !== tab) setFileMenu(undefined);
    onTabChange(next);
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

  function openFileMenu(event: MouseEvent<HTMLElement>, group: ChangeTreeGroup["id"], entry: ChangeTreeFile) {
    event.preventDefault();
    const anchor = event.currentTarget.querySelector<HTMLElement>(".changeTreeFile") ?? event.currentTarget;
    // The context-menu key reports no pointer position, so the menu then opens under the row.
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    const rect = anchor.getBoundingClientRect();
    setFileMenu({ group, entry, anchor, x: fromKeyboard ? rect.left + 24 : event.clientX, y: fromKeyboard ? rect.bottom : event.clientY });
  }

  // Streamlined from IntelliJ's VCS menu to the everyday actions: review, add or stage, shelve, roll back,
  // history, and getting at the file on disk.
  function fileMenuItems({ group, entry }: FileMenu): ContextMenuItem[] {
    const { file, stage, scopes } = entry;
    const tracked = group === "changes";
    const targetPaths = group === "unversioned" && checkedPaths.includes(file.path) ? checkedPaths : [file.path];
    const items: ContextMenuItem[] = [];
    const add = (item: ContextMenuItem) => items.push(items.length === 0 ? { ...item, separatorBefore: false } : item);
    if (!file.path.endsWith("/")) {
      add({ id: "diff", label: t("ctx.showDiff"), icon: <MenuIcon name="diff" />, onSelect: () => onOpenFileDiff(file.path, scopes[0]) });
      if (onOpenDiffWindow && group !== "conflicts") add({ id: "window", label: t("ctx.openDiffWindow"), icon: <MenuIcon name="window" />, onSelect: () => onOpenDiffWindow(file.path, scopes[0]) });
    }
    if (group === "unversioned") {
      add({ id: "add", label: targetPaths.length > 1 ? t("ctx.addSelected", { count: targetPaths.length }) : t("ctx.add"), icon: <MenuIcon name="add" />, separatorBefore: true, disabled: stagingBlocked || !unversioned?.some(({ file: current }) => current.path === file.path), onSelect: () => addUnversioned(targetPaths) });
    } else if (tracked) {
      add({ id: "stage", label: t("ctx.stage"), icon: <MenuIcon name="add" />, separatorBefore: true, disabled: stagingBlocked || stage === "staged", onSelect: () => onStageChanges("stageFile", file.path) });
      add({ id: "unstage", label: t("ctx.unstage"), icon: <MenuIcon name="remove" />, disabled: stagingBlocked || stage === "unstaged", onSelect: () => onStageChanges("unstageFile", file.path) });
    }
    if (onShelveFiles && (tracked || group === "unversioned")) {
      const scope: DiffScope = scopes.includes("workingTree") ? "workingTree" : "index";
      add({ id: "shelve", label: t("ctx.shelve"), title: t("ctx.shelveTitle"), icon: <MenuIcon name="shelve" />, separatorBefore: true, disabled: shelveBlocked, onSelect: () => onShelveFiles(targetPaths, scope) });
    }
    if (onIgnorePath && group === "unversioned") {
      const ignoreBlocked = !connected || repository.availability !== "available";
      const isFolder = file.path.endsWith("/");
      const hasFolder = isFolder || file.path.includes("/");
      const hasExtension = !isFolder && /[^/]\.[^./]+$/.test(file.path);
      add({ id: "ignore-file", label: isFolder ? t("ctx.ignoreFolderItself") : t("ctx.ignoreFile"), icon: <MenuIcon name="ignore" />, separatorBefore: true, disabled: ignoreBlocked, onSelect: () => onIgnorePath(file.path, "file") });
      add({ id: "ignore-extension", label: t("ctx.ignoreExtension"), disabled: ignoreBlocked || !hasExtension, title: hasExtension ? undefined : t("ctx.ignoreNoExtension"), onSelect: () => onIgnorePath(file.path, "extension") });
      if (!isFolder) add({ id: "ignore-folder", label: t("ctx.ignoreFolder"), disabled: ignoreBlocked || !hasFolder, title: hasFolder ? undefined : t("ctx.ignoreNoFolder"), onSelect: () => onIgnorePath(file.path, "folder") });
    }
    if (onRollbackFile && tracked) {
      const rollbackable = scopes.includes("workingTree");
      add({ id: "rollback", label: t("ctx.rollback"), icon: <MenuIcon name="rollback" />, danger: true, disabled: stagingBlocked || !rollbackable, title: rollbackable ? t("ctx.rollbackTitle") : t("ctx.rollbackStagedOnly"), onSelect: () => onRollbackFile(file.path) });
    }
    if (onShowFileHistory && (tracked || group === "conflicts")) {
      add({ id: "history", label: t("ctx.history"), icon: <MenuIcon name="history" />, separatorBefore: true, disabled: file.kind === "added", title: file.kind === "added" ? t("ctx.historyNone") : undefined, onSelect: () => onShowFileHistory(file.path) });
    }
    if (onOpenInEditor && file.kind !== "deleted") {
      add({ id: "open-editor", label: t("ctx.openInEditor"), separatorBefore: true, disabled: !connected || repository.availability !== "available", onSelect: () => onOpenInEditor(file.path) });
    }
    const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => undefined); };
    add({ id: "copy", label: t("ctx.copyPath"), icon: <MenuIcon name="copy" />, separatorBefore: true, onSelect: () => copy(absoluteFilePath(repository.path, file.path)) });
    add({ id: "copy-relative", label: t("ctx.copyRelativePath"), onSelect: () => copy(file.path) });
    if (onRevealFile) {
      const platform = navigator.platform.toLowerCase();
      const label = platform.includes("mac") ? t("ctx.revealFinder") : platform.includes("win") ? t("ctx.revealExplorer") : t("ctx.revealFiles");
      add({ id: "reveal", label, icon: <MenuIcon name="reveal" />, disabled: file.kind === "deleted", onSelect: () => onRevealFile(absoluteFilePath(repository.path, file.path)) });
    }
    return items;
  }

  function fileRow(group: ChangeTreeGroup["id"], entry: ChangeTreeFile) {
    const { file, stage, scopes } = entry;
    const selected = selectedFilePath === file.path;
    const slash = file.path.lastIndexOf("/");
    const checkable = group === "changes" || group === "unversioned";
    const isUnversioned = group === "unversioned";
    const onToggle = () => isUnversioned ? toggleUnversioned([file.path]) : toggleFile(entry);
    const openScope = selected && selectedFileScope && scopes.includes(selectedFileScope) ? selectedFileScope : scopes[0];
    return (
      <li className={`changeTreeRow${selected ? " selected" : ""}${fileMenu?.entry.file.path === file.path ? " menuOpen" : ""}`} key={file.path} onContextMenu={(event) => openFileMenu(event, group, entry)}>
        {checkable ? <Checkbox
          checked={isUnversioned ? checkedUnversioned.has(file.path) : stage === "staged"}
          indeterminate={stage === "partial"}
          disabled={!isUnversioned && stagingBlocked}
          label={t(isUnversioned ? "cp.selectFile" : "nav.stageFile", { path: file.path })}
          title={isUnversioned ? t("cp.selectFile", { path: file.path }) : stage === "partial" ? t("cp.partial") : stage === "staged" ? t("nav.unstageThis") : t("nav.stageThis")}
          onToggle={onToggle}
        /> : <span className="treeCheckboxSpacer" aria-hidden="true" />}
        <button
          className="changeTreeFile"
          type="button"
          aria-label={`${file.kind} ${file.path}`}
          aria-pressed={selected}
          aria-keyshortcuts={checkable ? "Space Enter" : "Enter"}
          title={file.originalPath ? `${file.originalPath} → ${file.path}` : t("nav.review", { path: file.path })}
          onClick={() => onOpenFileDiff(file.path, openScope)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const rows = [...(event.currentTarget.closest(".changeTree")?.querySelectorAll<HTMLButtonElement>(".changeTreeFile") ?? [])];
            const index = rows.indexOf(event.currentTarget);
            const target = event.key === "ArrowDown" ? rows[Math.min(index + 1, rows.length - 1)]
              : event.key === "ArrowUp" ? rows[Math.max(0, index - 1)]
                : event.key === "Home" ? rows[0] : event.key === "End" ? rows[rows.length - 1] : undefined;
            if (target) {
              event.preventDefault();
              event.stopPropagation();
              target.focus();
              target.scrollIntoView?.({ block: "nearest" });
            } else if (event.key === " " && checkable) {
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat && (isUnversioned || !stagingBlocked)) onToggle();
            }
          }}
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

  const panels = {
    commit: tab === "commit" && <>
        <InlineHint id="changes" label={t("hint.changesTitle")}>{t("hint.changes")}</InlineHint>
        <div className="commitPanelToolbar" role="toolbar" aria-label={t("cp.toolbar")}>
          <button className="quietButton compact iconButton" type="button" disabled={statusLoading} onClick={() => onRefreshStatus(repository.repoId, true)} aria-keyshortcuts={ariaShortcut(shortcuts.refreshStatus, isMacPlatform)} aria-label={statusLoading ? t("main.refreshingLabel") : t("main.refreshLabel")} title={statusLoading ? t("main.refreshingLabel") : t("main.refreshTitle", { shortcut: displayShortcut(shortcuts.refreshStatus, isMacPlatform) })}><span className={statusLoading ? "spinGlyph" : undefined}><Icon name="refresh" /></span></button>
          <button className="quietButton compact iconButton" type="button"
            disabled={checkedPaths.length ? stagingBlocked : workingCount === 0 || bulkBlocked}
            aria-keyshortcuts={checkedPaths.length ? undefined : ariaShortcut(shortcuts.stageAll, isMacPlatform)}
            aria-label={checkedPaths.length ? t("cp.stageSelected", { count: checkedPaths.length }) : t("nav.stageAll")}
            title={checkedPaths.length ? t("cp.stageSelected", { count: checkedPaths.length }) : t("nav.stageAllTitle", { shortcut: displayShortcut(shortcuts.stageAll, isMacPlatform) })}
            onClick={() => checkedPaths.length ? addUnversioned(checkedPaths) : onStageChanges("stageAll")}><Icon name="stageAll" /></button>
          <button className="quietButton compact iconButton" type="button" disabled={!status || stagedCount === 0 || bulkBlocked} aria-label={t("nav.unstageAll")} title={t("nav.unstageAll")} onClick={() => onStageChanges("unstageAll")}><Icon name="unstageAll" /></button>
          <button className="quietButton compact iconButton" type="button" disabled={!connected || repository.availability !== "available" || hasActiveRepositoryTask} aria-keyshortcuts={ariaShortcut(shortcuts.shelve, isMacPlatform)} aria-label={t("cp.shelve")} title={t("cp.shelveTitle", { shortcut: displayShortcut(shortcuts.shelve, isMacPlatform) })} onClick={onShelve}><Icon name="shelve" /></button>
          <span className="toolbarDivider" aria-hidden="true" />
          <button className="quietButton compact iconButton" type="button" disabled={visibleGroups.length === 0} aria-label={t("cp.expandAll")} title={t("cp.expandAll")} onClick={() => setCollapsed(new Set())}><Icon name="expand" /></button>
          <button className="quietButton compact iconButton" type="button" disabled={visibleGroups.length === 0} aria-label={t("cp.collapseAll")} title={t("cp.collapseAll")} onClick={() => setCollapsed(new Set(tree.map((group) => group.id)))}><Icon name="collapse" /></button>
        </div>
        <div className="changeTree" ref={changeTreeRef} onScroll={(event) => { changeTreeScroll.current = event.currentTarget.scrollTop; }}>
          {!status && statusLoading && <p className="sidebarNotice" role="status">{t("nav.loadingStatus")}</p>}
          {!status && statusError && <div className="statusLoadError" role="alert"><span><ErrorMessage error={statusError} /></span><button type="button" onClick={() => onRefreshStatus(repository.repoId, true)}>{t("nav.retry")}</button></div>}
          {status && statusError && <div className="statusStaleNotice" role="status">{t("nav.staleStatus")}</div>}
          {status && visibleGroups.length === 0 && <p className="sidebarNotice">{t("cp.noChanges")}</p>}
          {visibleGroups.map((group) => {
            const label = t(GROUP_LABEL[group.id]);
            const open = !collapsed.has(group.id);
            const checkable = group.id === "changes" || group.id === "unversioned";
            const isUnversioned = group.id === "unversioned";
            const allChecked = isUnversioned ? checkedPaths.length === group.files.length : group.files.every(({ stage }) => stage === "staged");
            const someChecked = isUnversioned ? checkedPaths.length > 0 : group.files.some(({ stage }) => stage !== "unstaged");
            return (
              <section className={`changeTreeGroup group-${group.id}`} key={group.id} aria-label={label}>
                <div className="changeTreeGroupRow">
                  <button className="treeToggle" type="button" aria-expanded={open} aria-label={open ? t("cp.collapseGroup", { group: label }) : t("cp.expandGroup", { group: label })} onClick={() => toggleGroup(group.id)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></button>
                  {checkable ? <Checkbox
                    checked={allChecked}
                    indeterminate={someChecked && !allChecked}
                    disabled={!isUnversioned && stagingBlocked}
                    label={t(isUnversioned ? "cp.groupSelect" : "cp.groupCheck", { group: label })}
                    onToggle={() => isUnversioned ? toggleUnversioned(group.files.map(({ file }) => file.path)) : toggleGroupFiles(group.files)}
                  /> : <span className="treeCheckboxSpacer" aria-hidden="true" />}
                  <button className="changeTreeGroupName" type="button" tabIndex={-1} onClick={() => toggleGroup(group.id)}>{label}</button>
                  <span className="changeTreeGroupCount" title={filesLabel(group.files.length)}><span aria-hidden="true">{group.files.length}</span><span className="srOnly">{filesLabel(group.files.length)}</span></span>
                </div>
                {open && <ul>{group.files.map((entry) => fileRow(group.id, entry))}</ul>}
              </section>
            );
          })}
        </div>
        {composer}
        {fileMenu && <ContextMenu
          key={`${fileMenu.entry.file.path}:${fileMenu.x}:${fileMenu.y}`}
          x={fileMenu.x}
          y={fileMenu.y}
          label={t("ctx.menuLabel", { path: fileMenu.entry.file.path })}
          items={fileMenuItems(fileMenu)}
          returnFocusTo={fileMenu.anchor}
          onClose={() => setFileMenu(undefined)}
        />}
      </>,

    shelves: tab === "shelves" && api && <Suspense fallback={<div className="navEmpty" role="status" aria-live="polite">{t("nav.loadingShelves")}</div>}>
        <ShelfCenter
          key={repository.repoId}
          api={api}
          repoId={repository.repoId}
          headOid={repository.head}
          files={status?.files || []}
          statusReady={Boolean(status)}
          disabled={repositoryActionDisabled}
          refreshKey={historyRefreshKey}
          openComposerRequest={shelfComposerRequest}
          composerPreselect={shelfComposerPreselect}
          afterCreateAction={shelfComposerAfterSwitch ? { switchTarget: shelfComposerAfterSwitch.target, existingShelfIds: shelfComposerAfterSwitch.existingShelfIds } : undefined}
          onTaskSubmitted={onShelfTaskSubmitted}
          onComposerClosed={onShelfComposerClosed}
          onComposerRequestHandled={onShelfComposerRequestHandled}
          selectedFilePath={selectedSavedFile?.path}
          onOpenFile={onOpenShelfFile}
          onCloseFile={onCloseSavedFile}
        />
      </Suspense>,

    stash: tab === "stash" && (api ? <Suspense fallback={<p className="navEmpty" role="status">{t("stash.loading")}</p>}>
        <StashList
          key={repository.repoId}
          api={api}
          repoId={repository.repoId}
          refreshKey={historyRefreshKey}
          statusSnapshot={status}
          disabled={repositoryActionDisabled}
          onOpenFile={onOpenStashFile}
          onCloseFile={onCloseSavedFile}
          selectedFile={selectedSavedFile?.commitOid ? { path: selectedSavedFile.path, commitOid: selectedSavedFile.commitOid } : undefined}
          onTaskStarted={onStashTaskSubmitted}
        />
      </Suspense> : <p className="navEmpty" role="status">{t("stash.loading")}</p>),
  };

  return (
    <aside className="sidePanel commitPanel" aria-label={t("chg.aria")}>
      <div className="commitPanelTabs" role="tablist" aria-label={t("cp.tabsAria")}>
        {TABS.map(({ id, label }, index) => (
          <button key={id} type="button" role="tab" id={`commit-panel-tab-${id}`} aria-selected={tab === id} aria-controls={`commit-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? "commitPanelTab active" : "commitPanelTab"} onClick={() => changeTab(id)} onKeyDown={(event) => {
            const nextIndex = event.key === "Home" ? 0
              : event.key === "End" ? TABS.length - 1
                : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length
                  : event.key === "ArrowRight" ? (index + 1) % TABS.length : undefined;
            if (nextIndex === undefined || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            changeTab(TABS[nextIndex].id);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
          }}>{t(label)}</button>
        ))}
      </div>
      {TABS.map(({ id, bodyClass }) => <div
        key={id}
        className={id === tab ? bodyClass : undefined}
        hidden={id !== tab}
        id={`commit-panel-${id}`}
        role="tabpanel"
        aria-labelledby={`commit-panel-tab-${id}`}
        tabIndex={id === "stash" && id === tab ? 0 : undefined}
      >{panels[id]}</div>)}
    </aside>
  );
}
