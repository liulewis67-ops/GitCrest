import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { GitCrestApiClient, WorktreeSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";

type Worktree = WorktreeSnapshotResponse["worktrees"][number];

const MENU_WIDTH = 360;

function leafName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function FolderIcon() {
  return <svg className="worktreeSwitcherIcon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.25c0-.69.56-1.25 1.25-1.25h2.5l1.5 1.5h4.5c.69 0 1.25.56 1.25 1.25v5.5c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25Z" /></svg>;
}

/**
 * The toolbar's worktree picker, beside the branch: the main and linked worktrees of the repository, each opened as
 * its own repository tab. A repository without linked worktrees draws nothing, leaving the branch on its own.
 */
export function WorktreeSwitcher({ api, repoId, refreshKey, disabled, onOpen }: {
  api: GitCrestApiClient;
  repoId: string;
  refreshKey: number;
  disabled: boolean;
  onOpen: (path: string) => void;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<WorktreeSnapshotResponse>();
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const [filter, setFilter] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const open = Boolean(position);

  // Read again on every opening as well, so worktrees added or removed outside GitCrest show up.
  useEffect(() => {
    const controller = new AbortController();
    void api.withSignal(controller.signal).getRepositoryWorktrees(repoId).then((result) => {
      if (!controller.signal.aborted) setSnapshot(result);
    }).catch(() => {
      if (!controller.signal.aborted) setSnapshot(undefined);
    });
    return () => controller.abort();
  }, [api, repoId, refreshKey, open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setPosition(undefined);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close();
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", close);
    filterRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const worktrees = snapshot?.worktrees ?? [];
  const current = worktrees.find((worktree) => worktree.isCurrent);
  const query = filter.trim().toLowerCase();
  const matches = useMemo(() => worktrees.filter((worktree) => !query
    || leafName(worktree.path).toLowerCase().includes(query)
    || (worktree.branch ?? "").toLowerCase().includes(query)), [worktrees, query]);
  if (worktrees.length < 2 || !current) return null;
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
    setPosition({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)) });
  }

  function closeAndRestoreFocus() {
    setPosition(undefined);
    buttonRef.current?.focus();
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
      setPosition(undefined);
    }
  }

  function row(worktree: Worktree) {
    const name = leafName(worktree.path);
    const branch = worktree.branch ?? (worktree.detached ? t("wt.detached", { oid: worktree.head?.slice(0, 7) ?? "" }) : "");
    return <button
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
      <span className="worktreeSwitcherName">{name}</span>
      {worktree.isDirty && !worktree.isCurrent && <span className="worktreeDirty" title={t("wt.dirtyTitle")} aria-label={t("wt.dirtyAria")}>●</span>}
      <span className="worktreeSwitcherBranch">{worktree.prunable ? t("wt.missing") : branch}</span>
    </button>;
  }

  return <>
    <button
      ref={buttonRef}
      className="quietButton compact branchSelector worktreeSelector"
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      title={t("wts.title", { path: current.path })}
      onClick={toggle}
    >
      <FolderIcon />
      <span className="branchSelectorName">{leafName(current.path)}</span>
      <span className="branchSelectorCaret" aria-hidden="true">▾</span>
    </button>
    {position && <div ref={menuRef} className="worktreeSwitcherMenu" style={{ top: position.top, left: position.left, width: MENU_WIDTH }} onKeyDown={onMenuKeyDown}>
      <input ref={filterRef} className="worktreeSwitcherFilter" type="search" value={filter} placeholder={t("wts.filter")} aria-label={t("wts.filter")} onChange={(event) => setFilter(event.target.value)} />
      <div className="worktreeSwitcherList" role="menu" aria-label={t("wt.listAria")}>
        {main.length > 0 && <div role="group" aria-label={t("wts.main")}><div className="worktreeSwitcherHeading" aria-hidden="true">{t("wts.main")}</div>{main.map(row)}</div>}
        {linked.length > 0 && <div role="group" aria-label={t("wts.linked")}><div className="worktreeSwitcherHeading" aria-hidden="true">{t("wts.linked")}</div>{linked.map(row)}</div>}
        {matches.length === 0 && <p className="worktreeSwitcherEmpty">{t("wts.noMatch", { query: filter.trim() })}</p>}
      </div>
    </div>}
  </>;
}
