import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { useMenuPlacement } from "../../../shared/hooks/use-menu-placement";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { GitCrestApiClient, WorktreeSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { ContextMenu, type ContextMenuItem } from "../../../shared/ui/ContextMenu";
import { BatchRefDialog, type BatchRefTarget } from "./BatchRefDialog";
import { usePickerSelection } from "../model/use-picker-selection";
import type { TaskSnapshotResponse } from "../../../api/client";

type Worktree = WorktreeSnapshotResponse["worktrees"][number];

const MENU_WIDTH = 480;

function leafName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function FolderIcon() {
  return <svg className="worktreeSwitcherIcon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.25c0-.69.56-1.25 1.25-1.25h2.5l1.5 1.5h4.5c.69 0 1.25.56 1.25 1.25v5.5c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25Z" /></svg>;
}

/**
 * The toolbar's worktree picker, beside the branch: the main and linked worktrees of the repository, each opened as
 * its own repository tab. The main worktree stays available before any linked worktrees are created.
 */
export function WorktreeSwitcher({ api, repoId, refreshKey, disabled, onOpen, onNewWorktree, onNewWorktreeFrom, onRemove, onReveal, onTaskStarted, repositoryPath }: {
  api: GitCrestApiClient;
  repoId: string;
  refreshKey: number;
  disabled: boolean;
  onOpen: (path: string) => void;
  repositoryPath?: string;
  onNewWorktree?: () => void;
  onNewWorktreeFrom?: (oid: string, label: string) => void;
  onRemove?: (path: string) => void;
  onReveal?: (path: string) => void;
  onTaskStarted?: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<WorktreeSnapshotResponse>();
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const [filter, setFilter] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const selection = usePickerSelection();
  const [menu, setMenu] = useState<{ worktree: Worktree; x: number; y: number; anchor: HTMLElement }>();
  const [batch, setBatch] = useState<BatchRefTarget[]>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const open = Boolean(position);
  useMenuPlacement(menuRef, buttonRef, open, "start");

  // Read again on every opening as well, so worktrees added or removed outside GitCrest show up.
  useEffect(() => {
    const controller = new AbortController();
    void api.withSignal(controller.signal).getRepositoryWorktrees(repoId).then((result) => {
      if (!controller.signal.aborted) { setSnapshot(result); setLoadError(false); }
    }).catch(() => {
      if (!controller.signal.aborted) setLoadError(true);
    });
    return () => controller.abort();
  }, [api, repoId, refreshKey, open, reload]);
  useEffect(() => { selection.clear(); setSnapshot(undefined); setPosition(undefined); }, [repoId]);

  useEffect(() => {
    if (!open) return;
    const close = () => setPosition(undefined);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (batch || (target instanceof Element && target.closest(".actionMenu"))) return;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close();
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", close);
    if (!batch) filterRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", close);
    };
  }, [open, batch]);

  const worktrees = snapshot?.worktrees ?? [];
  const current = worktrees.find((worktree) => worktree.isCurrent);
  const query = filter.trim().toLowerCase();
  const matches = useMemo(() => worktrees.filter((worktree) => !query
    || leafName(worktree.path).toLowerCase().includes(query)
    || (worktree.branch ?? "").toLowerCase().includes(query)), [worktrees, query]);
  if (!current && !repositoryPath) return null;
  const main = matches.filter((worktree) => worktree.isMain);
  const linked = matches.filter((worktree) => !worktree.isMain);

  function toggle() {
    if (open) {
      setPosition(undefined);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setFilter("");
    selection.clear();
    setPosition({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)) });
  }

  function closeAndRestoreFocus() {
    setPosition(undefined);
    setMenu(undefined);
    buttonRef.current?.focus();
  }

  const selectedWorktrees = worktrees.filter(tree => selection.selected.has(tree.path));
  function blockedRemoval(tree: Worktree, batchRemoval = false) {
    return tree.isMain ? t("rw.isMain") : tree.isCurrent ? t("rw.isCurrent") : tree.locked ? t("rw.isLocked") : tree.isDirty && (batchRemoval || !onRemove) ? t("wt.dirtyTitle") : tree.prunable ? t("wt.missing") : undefined;
  }
  function removeSelected(trees = selectedWorktrees) {
    setMenu(undefined);
    setBatch(trees.map(tree => ({ id: tree.path, name: leafName(tree.path), detail: tree.path, blocked: blockedRemoval(tree, true), submit: () => api.removeRepositoryWorktree(repoId, tree.path, false) })));
  }
  function menuItems(tree: Worktree): ContextMenuItem[] {
    if (selection.selected.has(tree.path) && selectedWorktrees.length > 1) return [
      { id: "copy-paths", label: t("picker.copyPaths"), onSelect: () => { void navigator.clipboard?.writeText(selectedWorktrees.map(item => item.path).join("\n")); } },
      { id: "remove-selected", label: t("picker.remove"), danger: true, disabled, onSelect: () => removeSelected() },
    ];
    const items: ContextMenuItem[] = [
      { id: "open", label: t("wt.menuOpen"), disabled: disabled || tree.isCurrent || tree.prunable, onSelect: () => choose(tree) },
      { id: "copy", label: t("ctx.copyPath"), onSelect: () => { void navigator.clipboard?.writeText(tree.path); } },
    ];
    if (onReveal) items.push({ id: "reveal", label: t(navigator.platform.toLowerCase().includes("win") ? "ctx.revealExplorer" : navigator.platform.toLowerCase().includes("mac") ? "ctx.revealFinder" : "ctx.revealFiles"), disabled: tree.prunable, onSelect: () => onReveal(tree.path) });
    if (onNewWorktreeFrom && tree.head) items.push({ id: "new", label: t("wt.menuNewFrom"), disabled, onSelect: () => { closeAndRestoreFocus(); onNewWorktreeFrom(tree.head!, tree.branch ?? leafName(tree.path)); } });
    items.push({ id: "remove", label: t("wt.menuRemove"), danger: true, separatorBefore: true, disabled: disabled || Boolean(blockedRemoval(tree)), title: blockedRemoval(tree), onSelect: () => { if (onRemove) { closeAndRestoreFocus(); onRemove(tree.path); } else removeSelected([tree]); } });
    return items;
  }

  function choose(worktree: Worktree) {
    closeAndRestoreFocus();
    if (!worktree.isCurrent) onOpen(worktree.path);
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(".worktreeSwitcherRow:not(:disabled)") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? rows[Math.min(index + 1, rows.length - 1)] : index <= 0 ? undefined : rows[index - 1];
      if (next) next.focus();
      else filterRef.current?.focus();
    } else if (event.key === "Enter" && document.activeElement === filterRef.current && rows[0]) {
      event.preventDefault();
      rows[0].click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
    } else if (event.key === "Tab") {
      const controls = [...(menuRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? [])];
      const boundary = event.shiftKey ? controls[0] : controls[controls.length - 1];
      if (document.activeElement === boundary) {
        event.preventDefault();
        closeAndRestoreFocus();
      }
    }
  }

  function row(worktree: Worktree) {
    const name = leafName(worktree.path);
    const branch = worktree.branch ?? (worktree.detached ? t("wt.detached", { oid: worktree.head?.slice(0, 7) ?? "" }) : "");
    return <div key={worktree.path} className={`worktreePickerRow${selection.selected.has(worktree.path) ? " selected" : ""}`} onKeyDown={event => {
      if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
        event.preventDefault(); event.stopPropagation();
        const anchor = event.currentTarget.querySelector<HTMLButtonElement>(".worktreeSwitcherRow")!;
        const rect = anchor.getBoundingClientRect();
        if (!selection.selected.has(worktree.path)) selection.select([worktree.path]);
        setMenu({ worktree, x: rect.left, y: rect.bottom, anchor });
      }
    }} onContextMenu={event => {
      event.preventDefault(); event.stopPropagation();
      if (!selection.selected.has(worktree.path)) selection.select([worktree.path]);
      setMenu({ worktree, x: event.clientX, y: event.clientY, anchor: event.currentTarget.querySelector("button")! });
    }}>
      <input className="refPickerCheckbox" type="checkbox" aria-label={t("picker.select", { name })} checked={selection.selected.has(worktree.path)} onChange={() => {}} onClick={event => selection.toggle(worktree.path, matches.map(tree => tree.path), event.shiftKey)} />
      <button
      key={worktree.path}
      className={`worktreeSwitcherRow${worktree.isCurrent ? " current" : ""}`}
      type="button"
      role="menuitemradio"
      aria-checked={worktree.isCurrent}
      disabled={worktree.prunable}
      title={worktree.prunable ? t("wts.missingTitle", { path: worktree.path }) : worktree.path}
      onClick={() => choose(worktree)}
    >
      <span className="worktreeSwitcherCheck" aria-hidden="true">{worktree.isCurrent ? <svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7" /></svg> : <FolderIcon />}</span>
      <span className="worktreeSwitcherName">{name}<small title={worktree.path}>{worktree.path}</small></span>
      {worktree.isDirty && !worktree.isCurrent && <span className="worktreeDirty" title={t("wt.dirtyTitle")} aria-label={t("wt.dirtyAria")}>●</span>}
      {worktree.locked && <span title={t("rw.isLocked")} aria-label={t("rw.isLocked")}><UiIcon name="lock" /></span>}
      <span className="worktreeSwitcherBranch" title={branch}>{worktree.prunable ? t("wt.missing") : branch}</span>
    </button>
    <button className="quietButton compact iconButton" type="button" aria-label={t("wt.menuAria", { name })} aria-haspopup="menu" onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (!selection.selected.has(worktree.path)) selection.select([worktree.path]);
      setMenu({ worktree, x: rect.left, y: rect.bottom, anchor: event.currentTarget });
    }}><UiIcon name="more" /></button>
    </div>;
  }

  return <>
    <button
      ref={buttonRef}
      className="quietButton compact branchSelector worktreeSelector"
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`${t("picker.worktree")}: ${leafName(current?.path ?? repositoryPath ?? "")}`}
      disabled={disabled}
      title={t("wts.title", { path: current?.path ?? repositoryPath ?? "" })}
      onClick={toggle}
    >
      <FolderIcon />
      <span className="refPickerTriggerText"><small>{t("picker.worktree")}</small><span className="branchSelectorName">{leafName(current?.path ?? repositoryPath ?? "")}</span></span>
      <span className="branchSelectorCaret" aria-hidden="true"><UiIcon name="chevronDown" /></span>
    </button>
    {position && <div ref={menuRef} className="worktreeSwitcherMenu" style={{ top: position.top, left: position.left, width: `min(${MENU_WIDTH}px, calc(100vw - 16px))` }} onKeyDown={event => { if (!menu && !batch) onMenuKeyDown(event); }}>
      <div className="refPickerHeader"><strong>{t("wt.title")}</strong>{onNewWorktree && <button type="button" className="secondaryButton compact" disabled={disabled} onClick={() => { closeAndRestoreFocus(); onNewWorktree(); }}>{t("picker.newWorktree")}</button>}</div>
      <input ref={filterRef} className="worktreeSwitcherFilter" type="search" value={filter} placeholder={t("wts.filter")} aria-label={t("wts.filter")} onChange={(event) => setFilter(event.target.value)} />
      <div className="refPickerSelectionBar"><span aria-live="polite">{t("picker.selected", { count: selectedWorktrees.length })}</span><button type="button" className="textButton" onClick={() => selection.select(matches.map(tree => tree.path))}>{t("picker.selectAll")}</button>{selectedWorktrees.length > 0 && <><button type="button" className="textButton" onClick={selection.clear}>{t("picker.clear")}</button><button type="button" className="textButton" disabled={disabled} onClick={() => removeSelected()}>{t("wt.menuRemove")}</button></>}</div>
      {loadError && <p role="alert" className="dialogError">{t("picker.loadWorktreesFailed")} <button type="button" onClick={() => setReload(value => value + 1)}>{t("rr.retry")}</button></p>}
      {!snapshot && !loadError && <p role="status">{t("picker.loadingWorktrees")}</p>}
      <div className="worktreeSwitcherList" role="menu" aria-label={t("wt.listAria")}>
        {main.length > 0 && <div role="group" aria-label={t("wts.main")}><div className="worktreeSwitcherHeading" aria-hidden="true">{t("wts.main")}</div>{main.map(row)}</div>}
        {linked.length > 0 && <div role="group" aria-label={t("wts.linked")}><div className="worktreeSwitcherHeading" aria-hidden="true">{t("wts.linked")}</div>{linked.map(row)}</div>}
        {snapshot && matches.length === 0 && <p className="worktreeSwitcherEmpty">{t("wts.noMatch", { query: filter.trim() })}</p>}
      </div>
      <p className="refPickerHint">{t("picker.switchSingle")}</p>
    </div>}
    {menu && <ContextMenu x={menu.x} y={menu.y} label={t("wt.menuAria", { name: leafName(menu.worktree.path) })} items={menuItems(menu.worktree)} returnFocusTo={menu.anchor} onClose={() => setMenu(undefined)} />}
    {batch && <BatchRefDialog api={api} operation="remove" targets={batch} onTaskStarted={onTaskStarted} onChanged={() => { selection.clear(); setReload(value => value + 1); }} returnFocus={() => filterRef.current} onClose={() => setBatch(undefined)} />}
  </>;
}
