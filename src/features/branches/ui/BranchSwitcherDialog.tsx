import { useEffect, useState } from "react";
import type { BranchSnapshotResponse, RepositoryResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { BranchSyncBadge } from "./BranchSyncBadge";
import { rememberWorktreeParent, suggestWorktreePath, worktreePathInParent } from "../model/worktree-path";
import { useBranchSwitcher } from "../model/use-branch-switcher";
import { getRepositoryDisplayName } from "../../../shared/lib/repository-display-name";

interface BranchSwitcherDialogProps {
  repository?: RepositoryResponse;
  branchSwitcher: ReturnType<typeof useBranchSwitcher>;
  branches: BranchSnapshotResponse["branches"];
  hasBranchSnapshot: boolean;
  branchesLoading: boolean;
  branchError?: string;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  branchSwitcherShortcut: string;
  shelveShortcut: string;
  shelveAriaShortcut: string;
  onCommitChanges: () => void;
  onShelveAndSwitch: () => void;
  onOpenWorktree?: (path: string) => void;
  onChooseWorktreeParent?: () => Promise<string | undefined>;
}

export function BranchSwitcherDialog({
  repository,
  branchSwitcher,
  branches,
  hasBranchSnapshot,
  branchesLoading,
  branchError,
  connected,
  hasActiveRepositoryTask,
  branchSwitcherShortcut,
  shelveShortcut,
  shelveAriaShortcut,
  onCommitChanges,
  onShelveAndSwitch,
  onOpenWorktree,
  onChooseWorktreeParent,
}: BranchSwitcherDialogProps) {
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(
    branchSwitcher.close,
    branchSwitcher.busy,
    undefined,
    branchSwitcher.open,
  );

  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [worktreePath, setWorktreePath] = useState("");
  const [worktreeEdited, setWorktreeEdited] = useState(false);
  useEffect(() => {
    if (branchSwitcher.open) { setFilter(""); setCursor(0); setWorktreeEdited(false); }
  }, [branchSwitcher.open]);

  const suggestedWorktree = suggestWorktreePath(repository?.path, filter.trim());
  const effectiveWorktreePath = worktreeEdited ? worktreePath : suggestedWorktree;
  if (!branchSwitcher.open || !repository) return null;

  const query = filter.trim().toLowerCase();
  const allLocalBranches = branches
    .filter((branch) => branch.kind === "local" && !branch.isCurrent)
    .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite));
  const localBranches = query
    ? allLocalBranches.filter((branch) => branch.name.toLowerCase().includes(query))
    : allLocalBranches;
  const hasRemoteBranches = branches.some((branch) => branch.kind === "remote");
  const currentBranch = repository.detached
    ? `Detached · ${repository.head?.slice(0, 7)}`
    : repository.branch || "Unborn branch";

  return (
    <div
      className="paletteBackdrop branchSwitcherBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !branchSwitcher.busy) branchSwitcher.close();
      }}
    >
      <section
        ref={dialogRef}
        className="branchSwitcherDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-switcher-title"
        onKeyDown={onKeyDown}
      >
        <div className="dialogHeading">
          <div>
            <span className="sectionEyebrow">BRANCHES · {getRepositoryDisplayName(repository.path)}</span>
            <h2 id="branch-switcher-title">Switch branch</h2>
          </div>
          <button className="dialogClose" type="button" aria-label="Close branch switcher" disabled={branchSwitcher.busy} onClick={branchSwitcher.close}>×</button>
        </div>
        <p className="branchSwitcherCurrent">Current branch: <strong>{currentBranch}</strong></p>
        {branchSwitcher.targetName ? (
          <div className="branchSwitchDetails">
            <button className="textButton" type="button" disabled={branchSwitcher.busy} onClick={branchSwitcher.chooseAnother}>← Choose another branch</button>
            <h3>{branchSwitcher.targetName}</h3>
            {branchSwitcher.busy && !branchSwitcher.preflight && <p role="status">Checking the working tree…</p>}
            {branchSwitcher.error && <p className="dialogError" role="alert">{branchSwitcher.error}</p>}
            {branchSwitcher.preflight?.isClean && <p className="branchCleanNotice" role="status">The working tree is clean. GitCrest can switch to this branch.</p>}
            {branchSwitcher.preflight && !branchSwitcher.preflight.isClean && <>
              <p className="branchDirtyNotice" role="alert">Commit or shelve these changes before switching.</p>
              <div className="branchDirtyFiles" aria-label="Uncommitted files">
                {branchSwitcher.preflight.dirtyFiles.map((path) => (
                  <div className="branchDirtyFile" key={path}>
                    <span aria-hidden="true">•</span>
                    <span>{path}</span>
                    {branchSwitcher.preflight?.potentiallyOverwrittenPaths.includes(path) && <strong>May be overwritten</strong>}
                  </div>
                ))}
              </div>
              <div className="branchSwitchOptions">
                <button className="secondaryButton" type="button" onClick={onCommitChanges}>Commit changes</button>
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={branchSwitcher.busy || !connected || hasActiveRepositoryTask}
                  aria-keyshortcuts={shelveAriaShortcut}
                  title={`Shelve selected changes, then switch to ${branchSwitcher.targetName} (${shelveShortcut})`}
                  onClick={onShelveAndSwitch}
                >Shelve &amp; switch</button>
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={branchSwitcher.busy || (branchSwitcher.preflight?.potentiallyOverwrittenPaths.length ?? 1) > 0}
                  title={(branchSwitcher.preflight?.potentiallyOverwrittenPaths.length ?? 1) > 0
                    ? "The target branch changes one or more listed paths"
                    : "Switch branches while keeping these non-overlapping changes"}
                  onClick={() => void branchSwitcher.continueSwitch()}
                >Continue</button>
              </div>
            </>}
          </div>
        ) : (
          <div className="branchSwitchChoices">
            <h3>Local branches</h3>
            {(allLocalBranches.length > 0 || hasBranchSnapshot) && (
              <input
                className="branchFilterInput"
                type="search"
                autoFocus
                placeholder="Filter, or type a new branch name"
                aria-label="Filter local branches"
                value={filter}
                disabled={branchSwitcher.busy}
                onChange={(event) => { setFilter(event.target.value); setCursor(0); }}
                onKeyDown={(event) => {
                  if (branchSwitcher.busy) return;
                  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && localBranches.length > 0) {
                    event.preventDefault();
                    setCursor((current) => (Math.min(current, localBranches.length - 1) + (event.key === "ArrowDown" ? 1 : -1) + localBranches.length) % localBranches.length);
                    return;
                  }
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const highlighted = localBranches[Math.min(cursor, localBranches.length - 1)];
                  if (highlighted?.worktreePath && onOpenWorktree) { branchSwitcher.close(); onOpenWorktree(highlighted.worktreePath); }
                  else if (highlighted) void branchSwitcher.inspect(highlighted.name);
                  else if (query && connected) void branchSwitcher.createBranch(filter, { checkout: true });
                }}
              />
            )}
            {!hasBranchSnapshot && branchesLoading && <p role="status">Loading branches…</p>}
            {branchError && <p className="dialogError" role="alert">{branchError}</p>}
            {branchSwitcher.error && <p className="dialogError" role="alert">{branchSwitcher.error}</p>}
            {query && !branches.some((branch) => branch.kind === "local" && branch.name === filter.trim()) && (
              <div className="branchCreateOptions">
                <button className="branchChoice" type="button" disabled={branchSwitcher.busy || !connected} onClick={() => void branchSwitcher.createBranch(filter, { checkout: true })}>
                  <span className="branchItemGlyph" aria-hidden="true">+</span>
                  <span>Create and switch to “{filter.trim()}”</span>
                  <kbd>Enter</kbd>
                </button>
                <button className="branchChoice" type="button" disabled={branchSwitcher.busy || !connected} onClick={() => void branchSwitcher.createBranch(filter)}>
                  <span className="branchItemGlyph" aria-hidden="true">+</span>
                  <span>Create “{filter.trim()}” without switching</span>
                </button>
                <label className="branchWorktreeField">New worktree folder
                  <span className="branchWorktreeInput">
                    <input value={effectiveWorktreePath} aria-label="Worktree folder" spellCheck={false} disabled={branchSwitcher.busy} onChange={(event) => { setWorktreePath(event.target.value); setWorktreeEdited(true); }} />
                    {onChooseWorktreeParent && <button className="secondaryButton" type="button" disabled={branchSwitcher.busy} onClick={() => void onChooseWorktreeParent().then((parent) => {
                      if (!parent) return;
                      setWorktreePath(worktreePathInParent(parent, suggestedWorktree));
                      setWorktreeEdited(true);
                    }).catch(() => undefined)}>Browse…</button>}
                  </span>
                </label>
                <button className="branchChoice" type="button" disabled={branchSwitcher.busy || !connected || !effectiveWorktreePath.trim()} onClick={() => { rememberWorktreeParent(effectiveWorktreePath); void branchSwitcher.createBranch(filter, { worktreePath: effectiveWorktreePath.trim() }); }}>
                  <span className="branchItemGlyph" aria-hidden="true">⧉</span>
                  <span>Create “{filter.trim()}” in a new worktree</span>
                </button>
              </div>
            )}
            {hasBranchSnapshot && allLocalBranches.length === 0 && <p className="navEmpty">There are no other local branches.</p>}
            {allLocalBranches.length > 0 && localBranches.length === 0 && <p className="navEmpty">No branch matches “{filter.trim()}”.</p>}
            {localBranches.map((branch, position) => branch.worktreePath && onOpenWorktree ? (
              <div className="branchChoice inWorktree" key={branch.fullName}>
                <span className="branchItemGlyph" aria-hidden="true">⧉</span>
                <span title={branch.worktreePath}>{branch.name}</span>
                <small>open in another worktree</small>
                <button className="secondaryButton" type="button" disabled={branchSwitcher.busy} onClick={() => { branchSwitcher.close(); onOpenWorktree(branch.worktreePath!); }}>Open worktree</button>
              </div>
            ) : (
              <button className={`branchChoice${position === Math.min(cursor, localBranches.length - 1) ? " active" : ""}`} type="button" key={branch.fullName} ref={(node) => { if (node && position === Math.min(cursor, localBranches.length - 1)) node.scrollIntoView?.({ block: "nearest" }); }} disabled={branchSwitcher.busy} onClick={() => void branchSwitcher.inspect(branch.name)}>
                <span className="branchItemGlyph" aria-hidden="true">⑂</span>
                <span>{branch.name}</span>
                <BranchSyncBadge branch={branch} />
                {branch.isFavorite && <span className="branchFavoriteMark" aria-label="Favorite">★</span>}
                <span className="actionArrow" aria-hidden="true">→</span>
              </button>
            ))}
            {hasRemoteBranches && <p className="branchRemoteNote">Remote branches are shown in navigation. Check out a local tracking branch before switching to a remote branch.</p>}
          </div>
        )}
        <div className="dialogActions">
          <button className="secondaryButton" type="button" disabled={branchSwitcher.busy} onClick={branchSwitcher.close}>Cancel</button>
          {branchSwitcher.targetName && branchSwitcher.preflight?.isClean && (
            <button className="primaryButton" type="button" disabled={branchSwitcher.busy} onClick={() => void branchSwitcher.continueSwitch()}>
              {branchSwitcher.busy ? "Switching…" : `Switch to ${branchSwitcher.targetName}`}
            </button>
          )}
        </div>
        <div className="branchSwitcherHint"><kbd>{branchSwitcherShortcut}</kbd> opens this switcher <span>Esc closes</span></div>
      </section>
    </div>
  );
}
