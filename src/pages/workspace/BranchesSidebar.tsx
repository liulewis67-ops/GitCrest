import { lazy, Suspense, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { BranchSnapshotResponse, GitCrestApiClient, RemoteSnapshotResponse, RepositoryResponse, TaskSnapshotResponse } from "../../api/client";
import { loadRemoteManager } from "../../features/remotes";
import { BranchRowMenu, BranchSyncBadge, WorktreeList } from "../../features/branches";
import { TagList } from "../../features/history";
import { displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { useI18n } from "../../shared/i18n";
import { ContextMenu, type ContextMenuItem } from "../../shared/ui/ContextMenu";

const RemoteManager = lazy(() => loadRemoteManager().then(({ RemoteManager }) => ({ default: RemoteManager })));

type Branch = BranchSnapshotResponse["branches"][number];

function Glyph({ name }: { name: "local" | "remote" | "chevron" }) {
  const paths = {
    local: <><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="5.5" r="1.5" /><path d="M5 5.5v5M11 7c0 2.5-6 1.5-6 3.5" /></>,
    remote: <path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5Z" />,
    chevron: <path d="m6 4 4 4-4 4" />,
  };
  return <svg className={`branchGlyph-${name}`} viewBox="0 0 16 16" aria-hidden="true">{paths[name]}</svg>;
}

function MenuIcon({ name }: { name: "checkout" | "branch" | "merge" | "rebase" | "worktree" | "rename" | "delete" | "copy" }) {
  const paths = {
    checkout: <><path d="M2.5 8h9" /><path d="m8.5 4.5 3.5 3.5-3.5 3.5" /><path d="M13.5 3v10" /></>,
    branch: <><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><path d="M5 5.5v5" /><path d="M11 4.5v5M8.5 7h5" /></>,
    merge: <><circle cx="5" cy="3.5" r="1.5" /><circle cx="5" cy="12.5" r="1.5" /><circle cx="11" cy="8" r="1.5" /><path d="M5 5v6M5 5c0 2.5 2 3 4.5 3" /></>,
    rebase: <><circle cx="5" cy="12.5" r="1.5" /><circle cx="11" cy="3.5" r="1.5" /><path d="M5 11V7a3 3 0 0 1 3-3h1.5" /></>,
    worktree: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6h11" /></>,
    rename: <><path d="M3 13h3l7-7-3-3-7 7Z" /><path d="m8.5 4.5 3 3" /></>,
    delete: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5" /><path d="M4.5 4.5 5 13h6l.5-8.5" /></>,
    copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  };
  return <svg viewBox="0 0 16 16">{paths[name]}</svg>;
}

type BranchMenu = { branch: Branch; x: number; y: number; anchor: HTMLElement };

interface BranchesSidebarProps {
  repository: RepositoryResponse;
  api?: GitCrestApiClient;
  branches?: BranchSnapshotResponse;
  orderedBranches: Branch[];
  branchError?: string;
  branchesLoading: boolean;
  remotes?: RemoteSnapshotResponse;
  remoteError?: string;
  remotesLoading: boolean;
  remoteActionBusy: boolean;
  remoteDisabledReason: string;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  historyRefreshKey: number;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  /** Full ref name of the branch whose history the commit graph shows. */
  selectedBranch?: string;
  /** The commit selected in History, marked in the tag list when a tag points at it. */
  selectedCommit?: string;
  onSelectCommit?: (oid: string) => void;
  /** Starts a tag on the selected commit, or on HEAD; offered from the empty tag list. */
  onCreateTag?: () => void;
  /** A tag push or remote tag delete started as a background task. */
  onTagTaskStarted?: (task: TaskSnapshotResponse) => void;
  onSelectBranch: (branch: Branch) => void;
  onManageAccounts: (hosts: string[]) => void;
  onRefreshBranches: (repoId: string) => void;
  onOpenBranchSwitcher: () => void;
  onDeleteRemoteBranch: (branchRef: string) => void;
  onSwitchBranch: (name: string) => void;
  /** Checks a remote branch out as a local branch that tracks it. */
  onCheckoutRemoteBranch: (name: string) => void;
  onMergeBranch: (oid: string, name: string) => void;
  onRebaseOnto: (oid: string) => void;
  onCreateBranchFrom: (oid: string) => void;
  onCopyBranchName: (name: string) => void;
  /** Opens the comparison with this branch or tag as its base. Comparing only reads, so it stays available while a task runs. */
  onCompareRef?: (name: string) => void;
  /** Open the Push and Pull dialogs for the current branch; the arrows on its row call them. */
  onOpenPushDialog?: () => void;
  onOpenPullDialog?: () => void;
  pushDisabledReason?: string;
  pullDisabledReason?: string;
  onOpenWorktree: (path: string) => void;
  onNewWorktreeForBranch: (name: string, fromRemote: boolean) => void;
  /** Starts a new branch at `oid` checked out in a new worktree, for a branch that is already checked out somewhere. */
  onNewWorktreeFrom: (oid: string, label: string) => void;
  /** Asks to remove a linked worktree; the caller confirms first. */
  onRemoveWorktree: (path: string) => void;
  onRevealPath?: (path: string) => void;
  onWorktreePruneStarted: (task: TaskSnapshotResponse) => void;
  onManageBranch: (name: string, mode: "rename" | "delete") => void;
  onToggleBranchFavorite: (fullName: string, favorite: boolean) => void;
  onRefreshRemotes: (repoId: string) => void;
  onAddRemote: (name: string, url: string) => void;
  onSetRemoteUrl: (name: string, url: string) => void;
  onDeleteRemote: (name: string) => void;
  onSetDefaultRemote: (name: string | null) => void;
  onSetBranchUpstream: (localBranch: string, remoteName: string, remoteBranch: string) => void;
  onOpenWebUrl?: (url: string) => void;
}

/** Branch browser for the Branches view: filterable local and remote branches, worktrees, and remotes. */
export function BranchesSidebar(props: BranchesSidebarProps) {
  const { t } = useI18n();
  const {
    repository, api, branches, orderedBranches, branchError, branchesLoading, remotes, remoteError, remotesLoading,
    remoteActionBusy, remoteDisabledReason, connected, hasActiveRepositoryTask, historyRefreshKey, shortcuts, isMacPlatform,
    selectedBranch, selectedCommit, onSelectCommit, onCreateTag, onTagTaskStarted, onSelectBranch, onManageAccounts, onRefreshBranches, onOpenBranchSwitcher, onDeleteRemoteBranch, onSwitchBranch,
    onCheckoutRemoteBranch, onMergeBranch, onRebaseOnto, onCreateBranchFrom, onCopyBranchName, onCompareRef, onOpenPushDialog, onOpenPullDialog, pushDisabledReason, pullDisabledReason, onOpenWorktree,
    onNewWorktreeForBranch, onNewWorktreeFrom, onRemoveWorktree, onRevealPath, onWorktreePruneStarted, onManageBranch, onToggleBranchFavorite, onRefreshRemotes, onAddRemote,
    onSetRemoteUrl, onDeleteRemote, onSetDefaultRemote, onSetBranchUpstream, onOpenWebUrl,
  } = props;
  const [query, setQuery] = useState("");
  const [branchMenu, setBranchMenu] = useState<BranchMenu>();
  const [localGroupOpen, setLocalGroupOpen] = useState(true);
  const [remoteGroupOpen, setRemoteGroupOpen] = useState(true);
  const hasSnapshot = Boolean(branches && Array.isArray(branches.branches));
  const needle = query.trim().toLowerCase();
  // A remote's symbolic HEAD only points at one of its branches; it is not a branch of its own.
  const listedBranches = orderedBranches.filter((branch) => !(branch.kind === "remote" && branch.fullName.endsWith("/HEAD")));
  const matching = needle ? listedBranches.filter((branch) => branch.fullName.toLowerCase().includes(needle)) : listedBranches;
  const localBranches = matching.filter((branch) => branch.kind === "local");
  const remoteBranches = matching.filter((branch) => branch.kind === "remote");
  const blocked = !connected || repository.availability !== "available" || hasActiveRepositoryTask;
  // A filter shows every match, whatever the groups' fold state.
  const showLocal = localGroupOpen || Boolean(needle);
  const showRemote = remoteGroupOpen || Boolean(needle);
  const visibleRows = [...(showLocal ? localBranches : []), ...(showRemote ? remoteBranches : [])];
  // One branch takes Tab focus; the arrow keys move between the others.
  const tabStop = visibleRows.find((branch) => branch.fullName === selectedBranch)
    ?? visibleRows.find((branch) => branch.isCurrent) ?? visibleRows[0];

  function groupLabel(label: string, count: number, open: boolean, toggleLabel: string, onToggle: () => void) {
    return (
      <li className="branchGroupLabel" role="presentation">
        <button type="button" aria-expanded={open} disabled={Boolean(needle)} aria-label={toggleLabel} onClick={onToggle}><Glyph name="chevron" />{label}</button>
        <span className="branchGroupCount">{count}</span>
      </li>
    );
  }

  /** Where the remote name ends in a remote branch such as origin/feature; the prefix is drawn quieter. */
  function remoteSlash(branch: Branch) {
    return branch.kind === "remote" ? branch.name.indexOf("/") : -1;
  }

  function openBranchMenu(event: MouseEvent<HTMLElement>, branch: Branch) {
    event.preventDefault();
    const anchor = event.currentTarget.querySelector<HTMLElement>(".branchItemSelect") ?? event.currentTarget;
    // The context-menu key reports no pointer position, so the menu then opens under the row.
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    const rect = anchor.getBoundingClientRect();
    setBranchMenu({ branch, anchor, x: fromKeyboard ? rect.left + 24 : event.clientX, y: fromKeyboard ? rect.bottom : event.clientY });
  }

  /** Arrow keys walk the visible branches and show each one's history, as the commit list does for commits. */
  function moveBranchFocus(event: KeyboardEvent<HTMLButtonElement>, branch: Branch) {
    const index = visibleRows.indexOf(branch);
    const target = event.key === "ArrowDown" ? visibleRows[index + 1]
      : event.key === "ArrowUp" ? visibleRows[index - 1]
        : event.key === "Home" ? visibleRows[0]
          : event.key === "End" ? visibleRows[visibleRows.length - 1] : undefined;
    if (!target) return;
    event.preventDefault();
    onSelectBranch(target);
    const buttons = event.currentTarget.closest(".branchList")?.querySelectorAll<HTMLButtonElement>("[data-branch-ref]") ?? [];
    [...buttons].find((button) => button.dataset.branchRef === target.fullName)?.focus();
  }

  // The actions that fit the branch: switching, starting work from it, combining it with the current branch, and
  // managing the branch itself. Each one opens the same dialog as its row button, so nothing runs without review.
  function branchMenuItems(branch: Branch): ContextMenuItem[] {
    const local = branch.kind === "local";
    const items: ContextMenuItem[] = [];
    if (local && branch.worktreePath) {
      items.push({ id: "open-worktree", label: t("bs.menuOpenWorktree"), title: branch.worktreePath, icon: <MenuIcon name="worktree" />, disabled: !connected || hasActiveRepositoryTask, onSelect: () => onOpenWorktree(branch.worktreePath!) });
    } else if (!branch.isCurrent) {
      items.push({ id: "checkout", label: local ? t("bs.menuCheckout") : t("bs.menuCheckoutRemote"), icon: <MenuIcon name="checkout" />, disabled: blocked, onSelect: () => local ? onSwitchBranch(branch.name) : onCheckoutRemoteBranch(branch.name) });
    }
    items.push({ id: "new-branch", label: t("bs.menuNewBranch"), icon: <MenuIcon name="branch" />, separatorBefore: items.length > 0, disabled: blocked, onSelect: () => onCreateBranchFrom(branch.oid) });
    // A branch can be checked out in one worktree at a time, so one that already is gets a new branch from its tip.
    if (local && (branch.isCurrent || branch.worktreePath)) {
      items.push({ id: "new-worktree-from", label: t("bs.menuNewWorktreeFrom", { name: branch.name }), icon: <MenuIcon name="worktree" />, disabled: blocked, onSelect: () => onNewWorktreeFrom(branch.oid, branch.name) });
    } else if (!branch.isCurrent) {
      items.push({ id: "new-worktree", label: t("br.openNewWorktree"), icon: <MenuIcon name="worktree" />, disabled: blocked, onSelect: () => onNewWorktreeForBranch(branch.name, !local) });
    }
    if (!branch.isCurrent) {
      items.push({ id: "merge", label: t("bs.menuMerge", { name: branch.name }), icon: <MenuIcon name="merge" />, separatorBefore: true, disabled: blocked, onSelect: () => onMergeBranch(branch.oid, branch.name) });
      items.push({ id: "rebase", label: t("bs.menuRebase", { name: branch.name }), icon: <MenuIcon name="rebase" />, disabled: blocked, onSelect: () => onRebaseOnto(branch.oid) });
    }
    if (local) {
      items.push({ id: "rename", label: t("br.rename"), icon: <MenuIcon name="rename" />, separatorBefore: true, disabled: blocked, onSelect: () => onManageBranch(branch.name, "rename") });
      if (!branch.isCurrent && branch.worktreePath) {
        const worktreePath = branch.worktreePath;
        items.push({ id: "remove-worktree", label: t("bs.menuRemoveWorktree"), title: worktreePath, icon: <MenuIcon name="delete" />, danger: true, disabled: blocked, onSelect: () => onRemoveWorktree(worktreePath) });
      }
      if (!branch.isCurrent) {
        items.push({ id: "delete", label: t("br.delete"), icon: <MenuIcon name="delete" />, danger: true, disabled: blocked || Boolean(branch.worktreePath), title: branch.worktreePath ? t("br.removeWorktreeFirst") : undefined, onSelect: () => onManageBranch(branch.name, "delete") });
      }
    } else {
      items.push({ id: "delete-remote", label: t("bs.menuDeleteRemote"), icon: <MenuIcon name="delete" />, danger: true, separatorBefore: true, disabled: blocked, onSelect: () => onDeleteRemoteBranch(branch.fullName) });
    }
    if (onCompareRef) items.push({ id: "compare", label: t("bs.menuCompare"), separatorBefore: true, onSelect: () => onCompareRef(branch.name) });
    items.push({ id: "copy", label: t("bs.menuCopyName"), icon: <MenuIcon name="copy" />, separatorBefore: true, onSelect: () => onCopyBranchName(branch.name) });
    return items;
  }

  function branchRow(branch: Branch) {
    const selected = selectedBranch === branch.fullName;
    return (
      <li className={`branchItem${branch.isCurrent ? " current" : ""}${selected ? " selected" : ""}${branchMenu?.branch.fullName === branch.fullName ? " menuOpen" : ""}`} key={branch.fullName} onClick={(event) => { if (!(event.target as Element).closest("button:not(.branchItemSelect)")) onSelectBranch(branch); }} onContextMenu={(event) => openBranchMenu(event, branch)}>
        <span className="branchItemGlyph" aria-hidden="true"><Glyph name={branch.kind} /></span>
        <button className="branchItemSelect" type="button" data-branch-ref={branch.fullName} aria-pressed={selected} aria-label={t("bs.showHistory", { name: branch.name })} tabIndex={branch === tabStop ? 0 : -1} onKeyDown={(event) => moveBranchFocus(event, branch)}>
          <span className="branchItemName" title={branch.fullName} aria-current={branch.isCurrent ? "page" : undefined}>{remoteSlash(branch) > 0
            ? <><span className="branchRemotePrefix">{branch.name.slice(0, remoteSlash(branch) + 1)}</span>{branch.name.slice(remoteSlash(branch) + 1)}</>
            : branch.name}</span>
        </button>
        {branch.isCurrent && <span className="branchCurrentLabel">HEAD</span>}
        {branch.worktreePath && <span className="branchWorktreeMark" title={t("nav.checkedOutIn", { path: branch.worktreePath })} aria-label={t("nav.checkedOutElsewhere", { path: branch.worktreePath })}>⧉</span>}
        <BranchSyncBadge
          branch={branch}
          showUnpublished
          {...(branch.isCurrent
            ? { onPush: onOpenPushDialog, onPull: onOpenPullDialog, pushDisabledReason, pullDisabledReason }
            : { staticHint: t("br.checkoutToSync") })}
        />
        {!branch.isCurrent && !branch.fullName.endsWith("/HEAD") && <span className="branchActions">
          {branch.kind === "local" && !branch.worktreePath && <button className="branchAction" type="button" aria-label={t("nav.switchTo", { name: branch.name })} title={t("nav.switchTo", { name: branch.name })} disabled={blocked} onClick={() => onSwitchBranch(branch.name)}>↪</button>}
          {branch.kind === "local" && branch.worktreePath && <button className="branchAction" type="button" aria-label={t("nav.openWorktreeOf", { name: branch.name })} title={t("nav.openWorktreeTitle", { name: branch.name, path: branch.worktreePath })} disabled={!connected || hasActiveRepositoryTask} onClick={() => onOpenWorktree(branch.worktreePath!)}>⧉</button>}
          <button className="branchAction" type="button" aria-label={t("nav.mergeAria", { name: branch.fullName })} title={t("nav.mergeTitle", { name: branch.name })} disabled={blocked} onClick={() => onMergeBranch(branch.oid, branch.name)}>⤴</button>
          {branch.kind === "remote" && <button className="branchAction" type="button" aria-label={t("nav.newWorktreeFor", { name: branch.name })} title={t("nav.newWorktreeFor", { name: branch.name })} disabled={blocked} onClick={() => onNewWorktreeForBranch(branch.name, true)}>⧉</button>}
          {branch.kind === "local" && <BranchRowMenu branch={branch.name} checkedOutAt={branch.worktreePath} disabled={blocked} onNewWorktree={() => onNewWorktreeForBranch(branch.name, false)} onRename={() => onManageBranch(branch.name, "rename")} onDelete={() => onManageBranch(branch.name, "delete")} />}
        </span>}
        {branch.kind === "remote" && !branch.fullName.endsWith("/HEAD") && <button className="branchRemoteDelete" type="button" aria-label={t("nav.deleteRemoteBranch", { name: branch.fullName })} title={t("nav.deleteRemoteBranch", { name: branch.fullName })} disabled={blocked} onClick={() => onDeleteRemoteBranch(branch.fullName)}>×</button>}
        <button className={`branchFavorite${branch.isFavorite ? " active" : ""}`} type="button" aria-label={branch.isFavorite ? t("nav.favoriteRemove", { name: branch.fullName }) : t("nav.favoriteAdd", { name: branch.fullName })} aria-pressed={branch.isFavorite} onClick={() => onToggleBranchFavorite(branch.fullName, branch.isFavorite)}>{branch.isFavorite ? "★" : "☆"}</button>
      </li>
    );
  }

  return (
    <aside className="sidePanel branchesSidebar" aria-label={t("bs.aria")}>
      <div className="sidePanelHeader">
        <span className="sidePanelTitle">{t("nav.branches")}</span>
        {hasSnapshot && <span className="countBadge">{listedBranches.length}</span>}
        <span className="sidePanelSpacer" />
        <button className="quietButton compact branchSwitcherButton" type="button" disabled={!connected || repository.availability !== "available"} title={t("page.switchBranches", { shortcut: displayShortcut(shortcuts.branchSwitcher, isMacPlatform) })} onClick={onOpenBranchSwitcher}>{t("bs.switcher")}</button>
      </div>
      {hasSnapshot && listedBranches.length > 0 && <div className="sidePanelFilter">
        <input type="search" aria-label={t("bs.filter")} placeholder={t("bs.filterPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
      </div>}
      <div className="sidePanelScroll">
        {branchesLoading && !branches && <p className="sidebarNotice" role="status">{t("nav.loadingBranches")}</p>}
        {branchError && <div className="statusLoadError" role="alert"><span>{branchError}</span><button type="button" onClick={() => onRefreshBranches(repository.repoId)}>{t("nav.retry")}</button></div>}
        {hasSnapshot && listedBranches.length === 0 && <p className="sidebarNotice">{t("nav.noBranches")}</p>}
        {hasSnapshot && needle && matching.length === 0 && <p className="sidebarNotice" role="status">{t("bs.noMatch", { query: query.trim() })}</p>}
        {hasSnapshot && matching.length > 0 && <ul className="branchList" aria-label={t("nav.branchListAria")}>
          {localBranches.length > 0 && groupLabel(t("bs.local"), localBranches.length, showLocal, showLocal ? t("bs.hideLocal") : t("bs.showLocal"), () => setLocalGroupOpen((open) => !open))}
          {showLocal && localBranches.map(branchRow)}
          {remoteBranches.length > 0 && groupLabel(t("bs.remote"), remoteBranches.length, showRemote, showRemote ? t("bs.hideRemote") : t("bs.showRemote"), () => setRemoteGroupOpen((open) => !open))}
          {showRemote && remoteBranches.map(branchRow)}
        </ul>}
        {api && onSelectCommit && <TagList api={api} repoId={repository.repoId} refreshKey={historyRefreshKey} selectedOid={selectedCommit} remoteNames={remotes?.remotes.map((remote) => remote.name)} disabled={blocked} onSelectCommit={onSelectCommit} onCreateTag={onCreateTag} onCompare={onCompareRef} onTaskStarted={onTagTaskStarted} />}
        {api && <WorktreeList api={api} repoId={repository.repoId} refreshKey={historyRefreshKey} disabled={!connected || hasActiveRepositoryTask} onOpen={onOpenWorktree} onNewWorktreeFrom={onNewWorktreeFrom} onRemove={onRemoveWorktree} onReveal={onRevealPath} onPruneStarted={onWorktreePruneStarted} />}
        <Suspense fallback={<div className="navEmpty" role="status" aria-live="polite">{t("nav.loadingRemotes")}</div>}><RemoteManager
          snapshot={remotes}
          branches={branches}
          onManageAccounts={onManageAccounts}
          loading={remotesLoading}
          busy={remoteActionBusy}
          disabled={blocked}
          disabledReason={remoteDisabledReason}
          error={remoteError || ""}
          onRefresh={() => onRefreshRemotes(repository.repoId)}
          onAdd={onAddRemote}
          onSetUrl={onSetRemoteUrl}
          onDelete={onDeleteRemote}
          onSetDefault={onSetDefaultRemote}
          onSetUpstream={onSetBranchUpstream}
          onOpenWebUrl={onOpenWebUrl}
        /></Suspense>
      </div>
      {branchMenu && <ContextMenu
        key={`${branchMenu.branch.fullName}:${branchMenu.x}:${branchMenu.y}`}
        x={branchMenu.x}
        y={branchMenu.y}
        label={t("br.actionsFor", { branch: branchMenu.branch.name })}
        items={branchMenuItems(branchMenu.branch)}
        returnFocusTo={branchMenu.anchor}
        onClose={() => setBranchMenu(undefined)}
      />}
    </aside>
  );
}
