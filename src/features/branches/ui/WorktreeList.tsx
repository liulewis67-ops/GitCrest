import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState, type MouseEvent } from "react";
import { type GitCrestApiClient, type TaskSnapshotResponse, type WorktreeSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { ContextMenu, type ContextMenuItem } from "../../../shared/ui/ContextMenu";

type Worktree = WorktreeSnapshotResponse["worktrees"][number];

function leafName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function revealLabelKey() {
  const platform = navigator.platform.toLowerCase();
  return platform.includes("mac") ? "ctx.revealFinder" : platform.includes("win") ? "ctx.revealExplorer" : "ctx.revealFiles";
}

/**
 * Lists the working trees of the repository. Each row opens its worktree as its own repository tab, and its
 * right-click menu holds the rest: starting another worktree from it, showing or copying its folder, and removing it.
 */
export function WorktreeList({ api, repoId, refreshKey, disabled, onOpen, onNewWorktreeFrom, onRemove, onReveal, onPruneStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  refreshKey: number;
  disabled: boolean;
  onOpen: (path: string) => void;
  /** Starts a new branch at the worktree's commit, checked out in another new worktree. */
  onNewWorktreeFrom: (oid: string, label: string) => void;
  /** Asks to remove the worktree; the caller confirms before anything is deleted. */
  onRemove: (path: string) => void;
  onReveal?: (path: string) => void;
  onPruneStarted: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<WorktreeSnapshotResponse>();
  const [menu, setMenu] = useState<{ worktree: Worktree; x: number; y: number; anchor: HTMLElement }>();
  const [error, setError] = useState<DisplayError>("");

  async function prune() {
    setError("");
    try {
      onPruneStarted(await api.pruneRepositoryWorktrees(repoId));
    } catch (reason) {
      setError(describeApiError(reason, t("wt.cleanupFailed")));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void api.withSignal(controller.signal).getRepositoryWorktrees(repoId).then((result) => {
      if (!controller.signal.aborted) setSnapshot(result);
    }).catch(() => {
      if (!controller.signal.aborted) setSnapshot(undefined);
    });
    return () => controller.abort();
  }, [api, repoId, refreshKey]);

  if (!snapshot?.worktrees || snapshot.worktrees.length < 2) return null;
  const anyPrunable = snapshot.worktrees.some((worktree) => worktree.prunable);

  function label(worktree: Worktree) {
    return worktree.branch ?? (worktree.detached ? t("wt.detached", { oid: worktree.head?.slice(0, 7) ?? "" }) : leafName(worktree.path));
  }

  function removeBlockedReason(worktree: Worktree) {
    return worktree.isMain ? t("rw.isMain") : worktree.isCurrent ? t("rw.isCurrent") : worktree.locked ? t("rw.isLocked") : undefined;
  }

  function openMenu(event: MouseEvent<HTMLElement>, worktree: Worktree) {
    event.preventDefault();
    const anchor = event.currentTarget.querySelector<HTMLElement>("button") ?? event.currentTarget;
    // The context-menu key reports no pointer position, so the menu then opens under the row.
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ worktree, anchor, x: fromKeyboard ? rect.left + 24 : event.clientX, y: fromKeyboard ? rect.bottom : event.clientY });
  }

  function menuItems(worktree: Worktree): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    if (worktree.prunable) {
      items.push({ id: "clean-up", label: t("wt.menuCleanUp"), title: t("wt.forgetTitle"), disabled, onSelect: () => void prune() });
    } else {
      if (!worktree.isCurrent) items.push({ id: "open", label: t("wt.menuOpen"), disabled, onSelect: () => onOpen(worktree.path) });
      const head = worktree.head;
      if (head) items.push({ id: "new-worktree", label: t("wt.menuNewFrom"), disabled, onSelect: () => onNewWorktreeFrom(head, label(worktree)) });
      if (onReveal) items.push({ id: "reveal", label: t(revealLabelKey()), separatorBefore: true, onSelect: () => onReveal(worktree.path) });
    }
    items.push({ id: "copy-path", label: t("ctx.copyPath"), separatorBefore: !onReveal || worktree.prunable, onSelect: () => { void navigator.clipboard?.writeText(worktree.path).catch(() => undefined); } });
    if (!worktree.prunable) {
      const blocked = removeBlockedReason(worktree);
      items.push({ id: "remove", label: t("wt.menuRemove"), danger: true, separatorBefore: true, disabled: disabled || Boolean(blocked), title: blocked, onSelect: () => onRemove(worktree.path) });
    }
    return items;
  }

  return <>
    <div className="navDivider" />
    <div className="navGroup worktreesNavigation">
      <div className="navGroupTitle"><span>{t("wt.title")}</span><span className="countBadge">{snapshot.worktrees.length}</span>{anyPrunable && <button className="textButton" type="button" disabled={disabled} title={t("wt.forgetTitle")} onClick={() => void prune()}>{t("wt.cleanUp")}</button>}</div>
      {error && <p className="dialogError" role="alert"><ErrorMessage error={error} /></p>}
      <ul className="branchList" aria-label={t("wt.listAria")}>
        {snapshot.worktrees.map((worktree) => (
          <li className={`branchItem${worktree.isCurrent ? " current" : ""}${menu?.worktree.path === worktree.path ? " menuOpen" : ""}`} key={worktree.path} onContextMenu={(event) => openMenu(event, worktree)}>
            <span className="branchItemGlyph" aria-hidden="true"><UiIcon name="copy" /></span>
            <span className="branchItemName" title={worktree.path}>{label(worktree)}</span>
            {worktree.isDirty && !worktree.isCurrent && <span className="worktreeDirty" title={t("wt.dirtyTitle")} aria-label={t("wt.dirtyAria")}>●</span>}
            {worktree.isCurrent
              ? <span className="branchCurrentLabel">{t("wt.openLabel")}</span>
              : <button className="branchAction worktreeOpen" type="button" aria-label={t("wt.openAria", { name: leafName(worktree.path) })} title={worktree.path} disabled={disabled || worktree.prunable} onClick={() => onOpen(worktree.path)}>{worktree.prunable ? t("wt.missing") : t("wt.open")}</button>}
            {!removeBlockedReason(worktree) && !worktree.prunable && <button className="branchAction worktreeRemove" type="button" aria-label={t("wt.removeAria", { name: leafName(worktree.path) })} title={t("wt.removeTitle", { path: worktree.path })} disabled={disabled} onClick={() => onRemove(worktree.path)}>{t("wt.remove")}</button>}
          </li>
        ))}
      </ul>
    </div>
    {menu && <ContextMenu
      key={`${menu.worktree.path}:${menu.x}:${menu.y}`}
      x={menu.x}
      y={menu.y}
      label={t("wt.menuAria", { name: leafName(menu.worktree.path) })}
      items={menuItems(menu.worktree)}
      returnFocusTo={menu.anchor}
      onClose={() => setMenu(undefined)}
    />}
  </>;
}
