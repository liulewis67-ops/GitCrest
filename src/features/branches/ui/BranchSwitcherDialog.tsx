import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useState } from "react";
import type { BranchSnapshotResponse, GitCrestApiClient, RepositoryResponse } from "../../../api/client";
import { BranchSyncBadge } from "./BranchSyncBadge";
import { useWorktreeFolderCheck, worktreeFolderProblemMessage } from "../model/use-worktree-folder-check";
import { isAbsoluteFolder, rememberWorktreeParent, suggestWorktreePath, worktreePathInParent } from "../model/worktree-path";
import { useBranchSwitcher } from "../model/use-branch-switcher";

interface BranchSwitcherDialogProps {
  repository?: RepositoryResponse;
  branchSwitcher: ReturnType<typeof useBranchSwitcher>;
  branches: BranchSnapshotResponse["branches"];
  hasBranchSnapshot: boolean;
  branchesLoading: boolean;
  branchError?: DisplayError;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  branchSwitcherShortcut: string;
  shelveShortcut: string;
  shelveAriaShortcut: string;
  onCommitChanges: () => void;
  onShelveAndSwitch: () => void;
  onOpenWorktree?: (path: string) => void;
  /** Lets the dialog check worktree folders while typing; creation is still validated by the engine. */
  api?: GitCrestApiClient;
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
  api,
  onChooseWorktreeParent,
}: BranchSwitcherDialogProps) {
  const { t } = useI18n();

  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [worktreePath, setWorktreePath] = useState("");
  const [worktreeEdited, setWorktreeEdited] = useState(false);
  useEffect(() => {
    if (branchSwitcher.open) { setFilter(""); setCursor(0); setWorktreeEdited(false); }
  }, [branchSwitcher.open]);

  const suggestedWorktree = suggestWorktreePath(repository?.path, filter.trim());
  const effectiveWorktreePath = worktreeEdited ? worktreePath : suggestedWorktree;
  const folderProblem = useWorktreeFolderCheck(api, repository?.repoId ?? "", effectiveWorktreePath, Boolean(branchSwitcher.open && filter.trim()));
  if (!branchSwitcher.open || !repository) return null;

  const query = filter.trim().toLowerCase();
  const allLocalBranches = branches
    .filter((branch) => branch.kind === "local" && !branch.isCurrent)
    .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite));
  const localBranches = query
    ? allLocalBranches.filter((branch) => branch.name.toLowerCase().includes(query))
    : allLocalBranches;
  // Remote branches switch through a local tracking branch; the one the current branch tracks is a pull, not a switch.
  const currentUpstream = branches.find((branch) => branch.kind === "local" && branch.isCurrent)?.upstream;
  const trackedBy = new Map(branches.filter((branch) => branch.kind === "local" && branch.upstream).map((branch) => [branch.upstream!, branch.name]));
  const allRemoteBranches = branches.filter((branch) => branch.kind === "remote" && !branch.fullName.endsWith("/HEAD") && branch.name !== currentUpstream);
  const remoteBranches = query
    ? allRemoteBranches.filter((branch) => branch.name.toLowerCase().includes(query))
    : allRemoteBranches;
  const choices = [...localBranches.map((branch) => ({ branch, remote: false })), ...remoteBranches.map((branch) => ({ branch, remote: true }))];
  const highlightedIndex = Math.min(cursor, choices.length - 1);
  const targetPreflight = branchSwitcher.preflight;
  const currentBranch = repository.detached
    ? t("bs.detached", { oid: repository.head?.slice(0, 7) ?? "" })
    : repository.branch || t("bs.unborn");

  return (
    <Dialog className="branchSwitcherDialog" role="dialog" aria-labelledby="branch-switcher-title" onClose={branchSwitcher.close} busy={branchSwitcher.busy} closeLabel={t("bs.closeAria")} backdropClassName="branchSwitcherBackdrop">
        <DialogHeader className="dialogHeading">
          <div>

            <h2 id="branch-switcher-title">{t("bs.title")}</h2>
          </div>

        </DialogHeader>
        <p className="branchSwitcherCurrent">{t("bs.current")} <strong>{currentBranch}</strong></p>
        {branchSwitcher.targetName ? (
          <div className="branchSwitchDetails">
            <Button variant="quiet" type="button" disabled={branchSwitcher.busy} onClick={branchSwitcher.chooseAnother}>{t("bs.chooseAnother")}</Button>
            <h3>{branchSwitcher.targetCommit ? t("bs.commitTitle", { oid: branchSwitcher.targetName.slice(0, 12) }) : branchSwitcher.targetName}</h3>
            {branchSwitcher.targetCommit && <p className="branchRemotePlan">{t("bs.detachedPlan")}</p>}
            {branchSwitcher.targetRemote && targetPreflight && <p className="branchRemotePlan">{targetPreflight.createsLocalBranch
              ? t("bs.remoteCreates", { remote: branchSwitcher.targetName, local: targetPreflight.localBranch })
              : t("bs.remoteUpdates", { remote: branchSwitcher.targetName, local: targetPreflight.localBranch })}</p>}
            {branchSwitcher.busy && !branchSwitcher.preflight && <p role="status">{t("bs.checking")}</p>}
            {branchSwitcher.error && <p className="dialogError" role="alert"><ErrorMessage error={branchSwitcher.error} /></p>}
            {branchSwitcher.preflight?.isClean && <p className="branchCleanNotice" role="status">{t("bs.clean")}</p>}
            {branchSwitcher.preflight && !branchSwitcher.preflight.isClean && <>
              <p className="branchDirtyNotice" role="alert">{t("bs.dirty")}</p>
              <div className="branchDirtyFiles" aria-label={t("bs.uncommittedFiles")}>
                {branchSwitcher.preflight.dirtyFiles.map((path) => (
                  <div className="branchDirtyFile" key={path}>
                    <span aria-hidden="true">•</span>
                    <span>{path}</span>
                    {branchSwitcher.preflight?.potentiallyOverwrittenPaths.includes(path) && <strong>{t("bs.mayOverwrite")}</strong>}
                  </div>
                ))}
              </div>
              <div className="branchSwitchOptions">
                <Button variant="secondary" type="button" onClick={onCommitChanges}>{t("bs.commitChanges")}</Button>
                <Button
                  variant="secondary"
                  type="button"
                  disabled={branchSwitcher.busy || !connected || hasActiveRepositoryTask}
                  aria-keyshortcuts={shelveAriaShortcut}
                  title={t("bs.shelveTitle", { name: branchSwitcher.targetName, shortcut: shelveShortcut })}
                  onClick={onShelveAndSwitch}
                >{t("bs.shelveSwitch")}</Button>
                <Button
                  variant="secondary"
                  type="button"
                  disabled={branchSwitcher.busy || !connected || hasActiveRepositoryTask}
                  title={t("preserve.hint")}
                  onClick={() => void branchSwitcher.continueSwitch()}
                >{t("bs.continue")}</Button>
              </div>
            </>}
          </div>
        ) : (
          <div className="branchSwitchChoices">
            <h3>{t("bs.localBranches")}</h3>
            {(allLocalBranches.length > 0 || allRemoteBranches.length > 0 || hasBranchSnapshot) && (
              <input
                className="branchFilterInput"
                type="search"
                autoFocus
                placeholder={t("bs.filterPlaceholder")}
                aria-label={t("bs.filterAria")}
                value={filter}
                disabled={branchSwitcher.busy}
                onChange={(event) => { setFilter(event.target.value); setCursor(0); }}
                onKeyDown={(event) => {
                  if (branchSwitcher.busy) return;
                  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && choices.length > 0) {
                    event.preventDefault();
                    setCursor((current) => (Math.min(current, choices.length - 1) + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
                    return;
                  }
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (event.shiftKey) {
                    // Shift+Enter: create the typed name in a new worktree at the suggested (or edited) folder.
                    const folderReady = effectiveWorktreePath.trim() !== "" && isAbsoluteFolder(effectiveWorktreePath) && !folderProblem;
                    if (query && connected && folderReady && !branches.some((candidate) => candidate.kind === "local" && candidate.name === filter.trim())) {
                      rememberWorktreeParent(effectiveWorktreePath);
                      void branchSwitcher.createBranch(filter, { worktreePath: effectiveWorktreePath.trim() });
                    }
                    return;
                  }
                  const highlighted = choices[highlightedIndex];
                  if (highlighted?.remote) void branchSwitcher.inspect(highlighted.branch.name, true);
                  else if (highlighted?.branch.worktreePath && onOpenWorktree) { branchSwitcher.close(); onOpenWorktree(highlighted.branch.worktreePath); }
                  else if (highlighted) void branchSwitcher.inspect(highlighted.branch.name);
                  else if (query && connected) void branchSwitcher.createBranch(filter, { checkout: true });
                }}
              />
            )}
            {!hasBranchSnapshot && branchesLoading && <p role="status">{t("bs.loadingBranches")}</p>}
            {branchError && <p className="dialogError" role="alert"><ErrorMessage error={branchError} /></p>}
            {branchSwitcher.error && <p className="dialogError" role="alert"><ErrorMessage error={branchSwitcher.error} /></p>}
            {query && !branches.some((branch) => branch.kind === "local" && branch.name === filter.trim()) && (
              <div className="branchCreateOptions">
                <button className="branchChoice" type="button" disabled={branchSwitcher.busy || !connected} onClick={() => void branchSwitcher.createBranch(filter, { checkout: true })}>
                  <span className="branchItemGlyph" aria-hidden="true">+</span>
                  <span>{t("bs.createSwitch", { name: filter.trim() })}</span>
                  <kbd>Enter</kbd>
                </button>
                <button className="branchChoice" type="button" disabled={branchSwitcher.busy || !connected} onClick={() => void branchSwitcher.createBranch(filter)}>
                  <span className="branchItemGlyph" aria-hidden="true">+</span>
                  <span>{t("bs.createStay", { name: filter.trim() })}</span>
                </button>
                <label className="branchWorktreeField">{t("bs.newWorktreeFolder")}
                  <span className="branchWorktreeInput">
                    <input value={effectiveWorktreePath} aria-label={t("bs.folderAria")} spellCheck={false} disabled={branchSwitcher.busy} onChange={(event) => { setWorktreePath(event.target.value); setWorktreeEdited(true); }} />
                    {onChooseWorktreeParent && <Button variant="secondary" type="button" disabled={branchSwitcher.busy} onClick={() => void onChooseWorktreeParent().then((parent) => {
                      if (!parent) return;
                      setWorktreePath(worktreePathInParent(parent, suggestedWorktree));
                      setWorktreeEdited(true);
                    }).catch(() => undefined)}>{t("bs.browse")}</Button>}
                  </span>
                </label>
                <button className="branchChoice" type="button" disabled={branchSwitcher.busy || !connected || !effectiveWorktreePath.trim() || !isAbsoluteFolder(effectiveWorktreePath) || Boolean(folderProblem)} onClick={() => { rememberWorktreeParent(effectiveWorktreePath); void branchSwitcher.createBranch(filter, { worktreePath: effectiveWorktreePath.trim() }); }}>
                  <span className="branchItemGlyph" aria-hidden="true"><UiIcon name="copy" /></span>
                  <span>{t("bs.createWorktree", { name: filter.trim() })}</span>
                  <kbd>Shift+Enter</kbd>
                  {effectiveWorktreePath.trim() !== "" && !isAbsoluteFolder(effectiveWorktreePath) && <small>{t("bs.fullPath")}</small>}
                  {folderProblem && <small role="alert">{worktreeFolderProblemMessage(folderProblem)}</small>}
                </button>
              </div>
            )}
            {hasBranchSnapshot && allLocalBranches.length === 0 && <p className="navEmpty">{t("bs.noOthers")}</p>}
            {allLocalBranches.length + allRemoteBranches.length > 0 && choices.length === 0 && <p className="navEmpty">{t("bs.noMatch", { name: filter.trim() })}</p>}
            {localBranches.map((branch, position) => branch.worktreePath && onOpenWorktree ? (
              <div className="branchChoice inWorktree" key={branch.fullName}>
                <span className="branchItemGlyph" aria-hidden="true"><UiIcon name="copy" /></span>
                <span title={branch.worktreePath}>{branch.name}</span>
                <small>{t("bs.openInOther")}</small>
                <Button variant="secondary" type="button" disabled={branchSwitcher.busy} onClick={() => { branchSwitcher.close(); onOpenWorktree(branch.worktreePath!); }}>{t("bs.openWorktree")}</Button>
              </div>
            ) : (
              <button className={`branchChoice${position === highlightedIndex ? " active" : ""}`} type="button" key={branch.fullName} ref={(node) => { if (node && position === highlightedIndex) node.scrollIntoView?.({ block: "nearest" }); }} disabled={branchSwitcher.busy} onClick={() => void branchSwitcher.inspect(branch.name)}>
                <span className="branchItemGlyph" aria-hidden="true"><UiIcon name="branch" /></span>
                <span>{branch.name}</span>
                <BranchSyncBadge branch={branch} />
                {branch.isFavorite && <span className="branchFavoriteMark" aria-label={t("bs.favorite")}><UiIcon name="star" style={{ fill: "currentColor" }} /></span>}
                <span className="actionArrow" aria-hidden="true"><UiIcon name="arrowRight" /></span>
              </button>
            ))}
            {remoteBranches.length > 0 && <>
              <h3 className="branchChoicesHeading">{t("bs.remoteBranches")}</h3>
              {remoteBranches.map((branch, index) => {
                const position = localBranches.length + index;
                const local = trackedBy.get(branch.name);
                return (
                  <button className={`branchChoice remote${position === highlightedIndex ? " active" : ""}`} type="button" key={branch.fullName} ref={(node) => { if (node && position === highlightedIndex) node.scrollIntoView?.({ block: "nearest" }); }} disabled={branchSwitcher.busy || !connected} title={local ? t("bs.remoteTrackedTitle", { remote: branch.name, local }) : t("bs.remoteNewTitle", { remote: branch.name })} onClick={() => void branchSwitcher.inspect(branch.name, true)}>
                    <svg className="branchItemGlyph remoteGlyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5Z" /></svg>
                    <span>{branch.name}</span>
                    <small className={local ? "branchChoiceTag" : "branchChoiceTag new"}>{local ? t("bs.remoteTracked", { name: local }) : t("bs.remoteNew")}</small>
                    <span className="actionArrow" aria-hidden="true"><UiIcon name="arrowRight" /></span>
                  </button>
                );
              })}
            </>}
          </div>
        )}
        <DialogFooter className="dialogActions">
          <Button variant="secondary" type="button" disabled={branchSwitcher.busy} onClick={branchSwitcher.close}>{t("bs.cancel")}</Button>
          {branchSwitcher.targetName && branchSwitcher.preflight?.isClean && (
            <Button variant="primary" type="button" disabled={branchSwitcher.busy} onClick={() => void branchSwitcher.continueSwitch()}>
              {branchSwitcher.busy ? t("bs.switching") : branchSwitcher.targetCommit ? t("bs.checkoutCommit") : branchSwitcher.targetRemote ? t("bs.fetchSwitch", { name: branchSwitcher.preflight.localBranch }) : t("bs.switchTo", { name: branchSwitcher.targetName })}
            </Button>
          )}
        </DialogFooter>
        <div className="branchSwitcherHint"><kbd>{branchSwitcherShortcut}</kbd> {t("bs.hintOpens")} <span>{t("bs.hintEsc")}</span></div>
      </Dialog>
  );
}
