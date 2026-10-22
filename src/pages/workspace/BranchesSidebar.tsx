import { lazy, Suspense, useState } from "react";
import type { BranchSnapshotResponse, GitCrestApiClient, RemoteSnapshotResponse, RepositoryResponse, TaskSnapshotResponse } from "../../api/client";
import { loadRemoteManager } from "../../features/remotes";
import { BranchRowMenu, BranchSyncBadge, WorktreeList } from "../../features/branches";
import { displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { useI18n } from "../../shared/i18n";

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
  onManageAccounts: (hosts: string[]) => void;
  onRefreshBranches: (repoId: string) => void;
  onOpenBranchSwitcher: () => void;
  onDeleteRemoteBranch: (branchRef: string) => void;
  onSwitchBranch: (name: string) => void;
  onMergeBranch: (oid: string, name: string) => void;
  onOpenWorktree: (path: string) => void;
  onNewWorktreeForBranch: (name: string, fromRemote: boolean) => void;
  onWorktreeRemoveStarted: (task: TaskSnapshotResponse) => void;
  onManageBranch: (name: string, mode: "rename" | "delete") => void;
  onToggleBranchFavorite: (fullName: string, favorite: boolean) => void;
  onRefreshRemotes: (repoId: string) => void;
  onAddRemote: (name: string, url: string) => void;
  onSetRemoteUrl: (name: string, url: string) => void;
  onDeleteRemote: (name: string) => void;
  onSetDefaultRemote: (name: string | null) => void;
  onSetBranchUpstream: (localBranch: string, remoteName: string, remoteBranch: string) => void;
}

/** Branch browser for the Branches view: filterable local and remote branches, worktrees, and remotes. */
export function BranchesSidebar(props: BranchesSidebarProps) {
  const { t } = useI18n();
  const {
    repository, api, branches, orderedBranches, branchError, branchesLoading, remotes, remoteError, remotesLoading,
    remoteActionBusy, remoteDisabledReason, connected, hasActiveRepositoryTask, historyRefreshKey, shortcuts, isMacPlatform,
    onManageAccounts, onRefreshBranches, onOpenBranchSwitcher, onDeleteRemoteBranch, onSwitchBranch, onMergeBranch, onOpenWorktree,
    onNewWorktreeForBranch, onWorktreeRemoveStarted, onManageBranch, onToggleBranchFavorite, onRefreshRemotes, onAddRemote,
    onSetRemoteUrl, onDeleteRemote, onSetDefaultRemote, onSetBranchUpstream,
  } = props;
  const [query, setQuery] = useState("");
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

  function branchRow(branch: Branch) {
    return (
      <li className={`branchItem${branch.isCurrent ? " current" : ""}`} key={branch.fullName}>
        <span className="branchItemGlyph" aria-hidden="true"><Glyph name={branch.kind} /></span>
        <span className="branchItemName" title={branch.fullName} aria-current={branch.isCurrent ? "page" : undefined}>{remoteSlash(branch) > 0
          ? <><span className="branchRemotePrefix">{branch.name.slice(0, remoteSlash(branch) + 1)}</span>{branch.name.slice(remoteSlash(branch) + 1)}</>
          : branch.name}</span>
        {branch.isCurrent && <span className="branchCurrentLabel">HEAD</span>}
        {branch.worktreePath && <span className="branchWorktreeMark" title={t("nav.checkedOutIn", { path: branch.worktreePath })} aria-label={t("nav.checkedOutElsewhere", { path: branch.worktreePath })}>⧉</span>}
        <BranchSyncBadge branch={branch} />
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
        {api && <WorktreeList api={api} repoId={repository.repoId} refreshKey={historyRefreshKey} disabled={!connected || hasActiveRepositoryTask} onOpen={onOpenWorktree} onRemoveStarted={onWorktreeRemoveStarted} />}
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
        /></Suspense>
      </div>
    </aside>
  );
}
