import type { BranchSnapshotResponse, RepositoryResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/use-dialog-focus";
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
}: BranchSwitcherDialogProps) {
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(
    branchSwitcher.close,
    branchSwitcher.busy,
    undefined,
    branchSwitcher.open,
  );

  if (!branchSwitcher.open || !repository) return null;

  const localBranches = branches.filter((branch) => branch.kind === "local" && !branch.isCurrent);
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
            {!hasBranchSnapshot && branchesLoading && <p role="status">Loading branches…</p>}
            {branchError && <p className="dialogError" role="alert">{branchError}</p>}
            {hasBranchSnapshot && localBranches.length === 0 && <p className="navEmpty">There are no other local branches.</p>}
            {localBranches.map((branch) => (
              <button className="branchChoice" type="button" key={branch.fullName} disabled={branchSwitcher.busy} onClick={() => void branchSwitcher.inspect(branch.name)}>
                <span className="branchItemGlyph" aria-hidden="true">⑂</span>
                <span>{branch.name}</span>
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
