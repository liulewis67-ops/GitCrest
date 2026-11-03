import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { BranchSnapshotResponse, GitCrestApiClient, RepositoryResponse } from "../../../api/client";
import { BranchSyncBadge } from "./BranchSyncBadge";
import { useWorktreeFolderCheck, worktreeFolderProblemMessage } from "../model/use-worktree-folder-check";
import { isAbsoluteFolder, rememberWorktreeParent, suggestWorktreePath, worktreePathInParent } from "../model/worktree-path";
import { useBranchSwitcher } from "../model/use-branch-switcher";
import { ContextMenu, type ContextMenuItem } from "../../../shared/ui/ContextMenu";
import { useBranchMenuItems, type BranchMenuActions } from "./use-branch-menu-items";
import { type BranchChangeMode, useBranchChangePolicy } from "../../../shared/preferences/branch-change-policy";

type Branch = BranchSnapshotResponse["branches"][number];

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
  onFetchAllRemotes?: () => void;
  remoteCount?: number;
  fetching?: boolean;
  actions?: BranchMenuActions & {
    onShowHistory: (branch: Branch) => void;
    onToggleFavorite: (branch: Branch) => void;
    onPush: () => void;
    onPull: () => void;
    pushDisabledReason?: string;
    pullDisabledReason?: string;
  };
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
  onFetchAllRemotes,
  remoteCount,
  fetching = false,
  actions,
}: BranchSwitcherDialogProps) {
  const { t } = useI18n();
  const changePolicy = useBranchChangePolicy();
  const [changeMode, setChangeMode] = useState<BranchChangeMode>("carry");
  const [rememberChanges, setRememberChanges] = useState(false);
  const changeChoiceRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setChangeMode("carry");
    setRememberChanges(false);
  }, [branchSwitcher.targetName, branchSwitcher.open]);
  useEffect(() => {
    if (branchSwitcher.choosingChanges) changeChoiceRef.current?.focus();
  }, [branchSwitcher.choosingChanges]);

  const activeChoiceRef = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  useEffect(() => { activeChoiceRef.current?.scrollIntoView?.({ block: "nearest" }); }, [cursor, filter, branchSwitcher.open, branchSwitcher.targetName]);
  const [worktreePath, setWorktreePath] = useState("");
  const [worktreeEdited, setWorktreeEdited] = useState(false);
  const [menu, setMenu] = useState<{ branch: Branch; x: number; y: number; anchor: HTMLElement }>();
  const blocked = !connected || repository?.availability !== "available" || hasActiveRepositoryTask || branchSwitcher.busy;
  const branchMenuItems = useBranchMenuItems(actions ? { ...actions, connected, blocked, hasActiveRepositoryTask } : undefined);
  useEffect(() => {
    setMenu(undefined);
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
  // Managed pickers include the current upstream so it has the same actions as every remote branch.
  const currentUpstream = branches.find((branch) => branch.kind === "local" && branch.isCurrent)?.upstream;
  const trackedBy = new Map(branches.filter((branch) => branch.kind === "local" && branch.upstream).map((branch) => [branch.upstream!, branch.name]));
  const allRemoteBranches = branches.filter((branch) => branch.kind === "remote" && !branch.fullName.endsWith("/HEAD") && (actions || branch.name !== currentUpstream));
  const remoteBranches = query
    ? allRemoteBranches.filter((branch) => branch.name.toLowerCase().includes(query))
    : allRemoteBranches;
  const choices = [...localBranches.map((branch) => ({ branch, remote: false })), ...remoteBranches.map((branch) => ({ branch, remote: true }))];
  const highlightedIndex = Math.min(cursor, choices.length - 1);
  const targetPreflight = branchSwitcher.preflight;
  const currentBranch = repository.detached
    ? t("bs.detached", { oid: repository.head?.slice(0, 7) ?? "" })
    : repository.branch || t("bs.unborn");
  const currentLocalBranch = actions ? branches.find((branch) => branch.isCurrent && branch.kind === "local" && (!query || branch.name.toLowerCase().includes(query))) : undefined;

  function openMenu(event: MouseEvent<HTMLElement>, branch: Branch) {
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget.querySelector<HTMLElement>("button") ?? event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    setMenu({ branch, anchor, x: event.clientX || rect.left, y: event.clientY || rect.bottom });
  }

  function menuItems(branch: Branch): ContextMenuItem[] {
    const items = branchMenuItems(branch);
    if (!actions) return items;
    if (branch.isCurrent) {
      items.unshift(
        { id: "commit", label: t("bs.commitChanges"), disabled: blocked, onSelect: onCommitChanges },
        { id: "pull", label: t("page.pull"), disabled: blocked || Boolean(actions.pullDisabledReason), title: actions.pullDisabledReason, onSelect: actions.onPull },
        { id: "push", label: t("page.push"), disabled: blocked || Boolean(actions.pushDisabledReason), title: actions.pushDisabledReason, onSelect: actions.onPush },
      );
    }
    items.push(
      { id: "history", label: t("bs.showHistory", { name: branch.name }), separatorBefore: true, onSelect: () => actions.onShowHistory(branch) },
      { id: "favorite", label: t(branch.isFavorite ? "nav.favoriteRemove" : "nav.favoriteAdd", { name: branch.fullName }), onSelect: () => actions.onToggleFavorite(branch) },
    );
    return items;
  }

  function branchControls(branch: Branch, content: ReactNode) {
    if (!actions) return content;
    return <div className={`branchPickerRow${branch.isCurrent ? " current" : ""}`} key={branch.fullName} onContextMenu={(event) => openMenu(event, branch)} onKeyDown={(event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault(); event.stopPropagation();
        const anchor = event.currentTarget.querySelector<HTMLElement>("button") ?? event.currentTarget;
        const rect = anchor.getBoundingClientRect();
        setMenu({ branch, anchor, x: rect.left, y: rect.bottom });
      }
    }}>
      {content}
      {branch.isCurrent && <span className="branchCurrentLabel">HEAD</span>}
      <BranchSyncBadge branch={branch} showUnpublished {...(branch.isCurrent ? { onPush: actions.onPush, onPull: actions.onPull, pushDisabledReason: actions.pushDisabledReason, pullDisabledReason: actions.pullDisabledReason } : { staticHint: t("br.checkoutToSync") })} />
      <button className={`branchFavorite${branch.isFavorite ? " active" : ""}`} type="button" aria-label={t(branch.isFavorite ? "nav.favoriteRemove" : "nav.favoriteAdd", { name: branch.fullName })} aria-pressed={branch.isFavorite} onClick={() => actions.onToggleFavorite(branch)}><UiIcon name="star" style={branch.isFavorite ? { fill: "currentColor" } : undefined} /></button>
      <button className="quietButton compact iconButton" type="button" aria-haspopup="menu" aria-expanded={menu?.branch.fullName === branch.fullName} aria-label={t("br.moreActionsFor", { branch: branch.name })} onClick={(event) => openMenu(event, branch)}><UiIcon name="more" /></button>
    </div>;
  }

  return (
    <Dialog className="branchSwitcherDialog" role="dialog" aria-labelledby="branch-switcher-title" onClose={branchSwitcher.close} busy={branchSwitcher.busy} closeLabel={t("bs.closeAria")} backdropClassName="branchSwitcherBackdrop">
        <DialogHeader className="dialogHeading">
          <div>

            <h2 id="branch-switcher-title">{t("bs.title")}</h2>
          </div>

        </DialogHeader>
        <div className="branchSwitcherToolbar">
          <p className="branchSwitcherCurrent">{t("bs.current")} <strong>{currentBranch}</strong></p>
          {onFetchAllRemotes && <Button size="compact" disabled={blocked || fetching || remoteCount === 0 || Boolean(branchSwitcher.targetName)} onClick={onFetchAllRemotes}>{fetching ? <span className="loadingSpinner small" aria-hidden="true" /> : <UiIcon name="refresh" />}{t("page.fetchAll")}</Button>}
        </div>
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
              {!branchSwitcher.choosingChanges && changePolicy !== "ask" && <p className="cloneHelp">{t(changePolicy === "keep" ? "bc.keepHelp" : "bc.carryHelp", { branch: changePolicy === "keep" ? currentBranch : branchSwitcher.targetName })}</p>}
              <div className="branchDirtyFiles" aria-label={t("bs.uncommittedFiles")}>
                {branchSwitcher.preflight.dirtyFiles.map((path) => (
                  <div className="branchDirtyFile" key={path}>
                    <span aria-hidden="true">•</span>
                    <span>{path}</span>
                    {branchSwitcher.preflight?.potentiallyOverwrittenPaths.includes(path) && <strong>{t("bs.mayOverwrite")}</strong>}
                  </div>
                ))}
              </div>
              {branchSwitcher.choosingChanges ? <div className="branchChangesPrompt">
                <fieldset className="branchChangesModes" disabled={blocked}>
                  <legend>{t("bc.prompt")}</legend>
                  <label><input ref={changeChoiceRef} type="radio" name="branch-change-mode" value="keep" checked={changeMode === "keep"} onChange={() => setChangeMode("keep")} /><span><strong>{t("bc.keep")}</strong><small>{t("bc.keepHelp", { branch: currentBranch })}</small></span></label>
                  <label><input type="radio" name="branch-change-mode" value="carry" checked={changeMode === "carry"} onChange={() => setChangeMode("carry")} /><span><strong>{t("bc.carry")}</strong><small>{t("bc.carryHelp", { branch: branchSwitcher.targetName })}</small></span></label>
                </fieldset>
                <fieldset className="branchChangesScope" disabled={blocked}>
                  <legend>{t("bc.scope")}</legend>
                  <label><input type="radio" name="branch-change-scope" checked={!rememberChanges} onChange={() => setRememberChanges(false)} />{t("bc.once")}</label>
                  <label><input type="radio" name="branch-change-scope" checked={rememberChanges} onChange={() => setRememberChanges(true)} />{t("bc.always")}</label>
                </fieldset>
                <p className="cloneHelp">{t("bc.preferenceHelp")}</p>
              </div> : <div className="branchSwitchOptions">
                <Button variant="secondary" type="button" onClick={onCommitChanges}>{t("bs.commitChanges")}</Button>
                <Button
                  variant="secondary"
                  type="button"
                  disabled={blocked || hasActiveRepositoryTask}
                  aria-keyshortcuts={shelveAriaShortcut}
                  title={t("bs.shelveTitle", { name: branchSwitcher.targetName, shortcut: shelveShortcut })}
                  onClick={onShelveAndSwitch}
                >{t("bs.shelveSwitch")}</Button>
                <Button
                  variant="secondary"
                  type="button"
                  disabled={blocked || hasActiveRepositoryTask}
                  title={changePolicy === "ask" ? t("bc.prompt") : t(changePolicy === "keep" ? "bc.keep" : "bc.carry")}
                  onClick={() => void branchSwitcher.continueSwitch()}
                >{t("bs.continue")}</Button>
              </div>}
            </>}
          </div>
        ) : (
          <div className="branchSwitchChoices">
            <h3>{t("bs.localBranches")}</h3>
            {(allLocalBranches.length > 0 || allRemoteBranches.length > 0 || hasBranchSnapshot) && (
              <input
                className="branchFilterInput"
                data-dialog-initial-focus
                type="search"
                autoFocus
                placeholder={t("bs.filterPlaceholder")}
                aria-label={t("bs.filterAria")}
                value={filter}
                disabled={branchSwitcher.busy}
                onChange={(event) => { setFilter(event.target.value); setCursor(0); }}
                onKeyDown={(event) => {
                  if (blocked) return;
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
                <button className="branchChoice" type="button" disabled={blocked} onClick={() => void branchSwitcher.createBranch(filter, { checkout: true })}>
                  <span className="branchItemGlyph" aria-hidden="true">+</span>
                  <span>{t("bs.createSwitch", { name: filter.trim() })}</span>
                  <kbd>Enter</kbd>
                </button>
                <button className="branchChoice" type="button" disabled={blocked} onClick={() => void branchSwitcher.createBranch(filter)}>
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
                <button className="branchChoice" type="button" disabled={blocked || !effectiveWorktreePath.trim() || !isAbsoluteFolder(effectiveWorktreePath) || Boolean(folderProblem)} onClick={() => { rememberWorktreeParent(effectiveWorktreePath); void branchSwitcher.createBranch(filter, { worktreePath: effectiveWorktreePath.trim() }); }}>
                  <span className="branchItemGlyph" aria-hidden="true"><UiIcon name="copy" /></span>
                  <span>{t("bs.createWorktree", { name: filter.trim() })}</span>
                  <kbd>Shift+Enter</kbd>
                  {effectiveWorktreePath.trim() !== "" && !isAbsoluteFolder(effectiveWorktreePath) && <small>{t("bs.fullPath")}</small>}
                  {folderProblem && <small role="alert">{worktreeFolderProblemMessage(folderProblem)}</small>}
                </button>
              </div>
            )}
            {currentLocalBranch && branchControls(currentLocalBranch, <button className="branchChoice" type="button" onClick={() => actions?.onShowHistory(currentLocalBranch)}><span className="branchItemGlyph" aria-hidden="true"><UiIcon name="branch" /></span><span>{currentLocalBranch.name}</span></button>)}
            {hasBranchSnapshot && !query && allLocalBranches.length === 0 && !currentLocalBranch && <p className="navEmpty">{t("bs.noOthers")}</p>}
            {hasBranchSnapshot && query && choices.length === 0 && !currentLocalBranch && <p className="navEmpty">{t("bs.noMatch", { name: filter.trim(), query: filter.trim() })}</p>}
            {localBranches.map((branch, position) => branchControls(branch, branch.worktreePath && onOpenWorktree ? (
              <div className="branchChoice inWorktree" key={branch.fullName}>
                <span className="branchItemGlyph" aria-hidden="true"><UiIcon name="copy" /></span>
                <span title={branch.worktreePath}>{branch.name}</span>
                <small>{t("bs.openInOther")}</small>
                <Button variant="secondary" type="button" disabled={branchSwitcher.busy} onClick={() => { branchSwitcher.close(); onOpenWorktree(branch.worktreePath!); }}>{t("bs.openWorktree")}</Button>
              </div>
            ) : (
              <button className={`branchChoice${position === highlightedIndex ? " active" : ""}`} type="button" key={branch.fullName} ref={position === highlightedIndex ? activeChoiceRef : undefined} disabled={blocked} onClick={() => void branchSwitcher.inspect(branch.name)}>
                <span className="branchItemGlyph" aria-hidden="true"><UiIcon name="branch" /></span>
                <span>{branch.name}</span>
                {!actions && <BranchSyncBadge branch={branch} />}
                {!actions && branch.isFavorite && <span className="branchFavoriteMark" aria-label={t("bs.favorite")}><UiIcon name="star" style={{ fill: "currentColor" }} /></span>}
                <span className="actionArrow" aria-hidden="true"><UiIcon name="arrowRight" /></span>
              </button>
            )))}
            {remoteBranches.length > 0 && <>
              <h3 className="branchChoicesHeading">{t("bs.remoteBranches")}</h3>
              {remoteBranches.map((branch, index) => {
                const position = localBranches.length + index;
                const local = trackedBy.get(branch.name);
                return (
                  branchControls(branch, <button className={`branchChoice remote${position === highlightedIndex ? " active" : ""}`} type="button" key={branch.fullName} aria-label={`${branch.name} ${local ? t("bs.remoteTracked", { name: local }) : t("bs.remoteNew")}`} ref={position === highlightedIndex ? activeChoiceRef : undefined} disabled={blocked} title={local ? t("bs.remoteTrackedTitle", { remote: branch.name, local }) : t("bs.remoteNewTitle", { remote: branch.name })} onClick={() => void branchSwitcher.inspect(branch.name, true)}>
                    <svg className="branchItemGlyph remoteGlyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5Z" /></svg>
                    <span>{branch.name}</span>
                    <small className={local ? "branchChoiceTag" : "branchChoiceTag new"}>{local ? t("bs.remoteTracked", { name: local }) : t("bs.remoteNew")}</small>
                    <span className="actionArrow" aria-hidden="true"><UiIcon name="arrowRight" /></span>
                  </button>)
                );
              })}
            </>}
          </div>
        )}
        <DialogFooter className="dialogActions">
          <Button variant="secondary" type="button" disabled={branchSwitcher.busy} onClick={branchSwitcher.close}>{t("bs.cancel")}</Button>
          {branchSwitcher.choosingChanges && <Button variant="primary" type="button" disabled={blocked} onClick={() => void branchSwitcher.continueSwitch(changeMode, rememberChanges)}>{t("bc.confirm")}</Button>}
          {branchSwitcher.targetName && branchSwitcher.preflight?.isClean && (
            <Button variant="primary" type="button" disabled={branchSwitcher.busy} onClick={() => void branchSwitcher.continueSwitch()}>
              {branchSwitcher.busy ? t("bs.switching") : branchSwitcher.targetCommit ? t("bs.checkoutCommit") : branchSwitcher.targetRemote ? t("bs.fetchSwitch", { name: branchSwitcher.preflight.localBranch }) : t("bs.switchTo", { name: branchSwitcher.targetName })}
            </Button>
          )}
        </DialogFooter>
        <div className="branchSwitcherHint"><kbd>{branchSwitcherShortcut}</kbd> {t("bs.hintOpens")} <span>{t("bs.hintEsc")}</span></div>
        {menu && <ContextMenu key={`${menu.branch.fullName}:${menu.x}:${menu.y}`} x={menu.x} y={menu.y} label={t("br.actionsFor", { branch: menu.branch.name })} items={menuItems(branches.find((branch) => branch.fullName === menu.branch.fullName) ?? menu.branch)} returnFocusTo={menu.anchor} onClose={() => setMenu(undefined)} />}
      </Dialog>
  );
}
