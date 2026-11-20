import { startComposition, endComposition, guardImeKey } from "../../../shared/lib/ime-guard";
import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { useI18n } from "../../../shared/i18n";
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { navigateMenu, useMenuPlacement } from "../../../shared/hooks/use-menu-placement";
import type { CommitRequest, GitCrestApiClient, RepositoryResponse, StatusSnapshotResponse } from "../../../api/client";
import { ariaShortcut, displayShortcut, matchesShortcut, type ShortcutPreferences } from "../../settings";
import { GitIdentityEditor } from "../../identity";
import type { CommitAction } from "../model/commit-action";

const CommitMessageAssistant = lazy(() => import("./CommitMessageAssistant").then(({ CommitMessageAssistant }) => ({ default: CommitMessageAssistant })));

// Git tooling commonly truncates subjects past 72 characters; this is advice, not a limit.
const SUMMARY_SOFT_LIMIT = 72;

interface CommitWorkbenchProps {
  repository?: RepositoryResponse;
  status: {
    snapshot?: StatusSnapshotResponse;
    stagedCount: number;
    workingCount?: number;
    hasConflicts: boolean;
    sensitiveStagedPaths: string[];
  };
  commit: {
    message: string;
    summary: string;
    description: string;
    template: string;
    selections: NonNullable<CommitRequest["selections"]>;
    selectionRepoId?: string;
    activeAction: CommitAction;
    actionLabel: string;
    actionIsDanger: boolean;
    actionMenuOpen: boolean;
    assistantOpen: boolean;
    amend: boolean;
    signOff: boolean;
    sign: boolean;
    busy: boolean;
    canCommit: boolean;
  };
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  api?: GitCrestApiClient;
  /** Git has no author name or email for this repository, so a commit would fail. */
  identityMissing?: boolean;
  onIdentitySaved?: () => void;
  onChangeMessage: (message: string) => void;
  onChangeSummary: (summary: string) => void;
  onChangeDescription: (description: string) => void;
  onChangeTemplate: (template: string) => void;
  onClearSelections: () => void;
  onAssistantOpenChange: (open: boolean) => void;
  onSelectAmend: (enabled: boolean) => void;
  onSelectSignOff: (enabled: boolean) => void;
  onSelectSign: (enabled: boolean) => void;
  onSubmit: (action: CommitAction) => void;
  onChooseAction: (action: CommitAction) => void;
  onToggleActionMenu: () => void;
  onStageAll?: () => void;
  onResolveConflicts?: () => void;
}

/** Writes and submits a commit of the staged changes at the bottom of the Commit panel, while there is something to commit. */
export function CommitWorkbench({
  repository,
  status,
  commit,
  shortcuts,
  isMacPlatform,
  connected,
  hasActiveRepositoryTask,
  api,
  identityMissing = false,
  onIdentitySaved,
  onChangeMessage,
  onChangeSummary,
  onChangeDescription,
  onChangeTemplate,
  onClearSelections,
  onAssistantOpenChange,
  onSelectAmend,
  onSelectSignOff,
  onSelectSign,
  onSubmit,
  onChooseAction,
  onToggleActionMenu,
  onStageAll,
  onResolveConflicts,
}: CommitWorkbenchProps) {
  const { t } = useI18n();
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [descriptionOpen, setDescriptionOpen] = useState(Boolean(commit.description));
  useEffect(() => { if (commit.description) setDescriptionOpen(true); }, [commit.description]);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const toggleMenuRef = useRef(onToggleActionMenu);
  toggleMenuRef.current = onToggleActionMenu;
  useMenuPlacement(actionMenuRef, actionButtonRef, commit.actionMenuOpen);
  useEffect(() => {
    if (!commit.actionMenuOpen) return;
    const menu = actionMenuRef.current;
    (menu?.querySelector<HTMLElement>("[aria-checked='true']:not(:disabled)") ?? menu?.querySelector<HTMLElement>("button:not(:disabled)") ?? menu)?.focus();
    const dismiss = (event: MouseEvent) => {
      if (!actionMenuRef.current?.contains(event.target as Node) && !actionButtonRef.current?.contains(event.target as Node)) toggleMenuRef.current();
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [commit.actionMenuOpen]);
  const [identityOpen, setIdentityOpen] = useState(false);
  const commitKeyShortcuts = `${ariaShortcut(shortcuts.commit, isMacPlatform)} ${ariaShortcut(shortcuts.commitAndPush, isMacPlatform)}`;
  const summaryLength = commit.summary.trim().length;
  const summaryTooLong = summaryLength > SUMMARY_SOFT_LIMIT;
  const target = repository?.detached ? t("cmp.titleDetached") : t("cmp.title", { branch: repository?.branch || t("page.unbornBranch") });
  const stagedLabel = status.stagedCount === 0 ? t("cmp.nothingStaged") : t(status.stagedCount === 1 ? "cmp.stagedOne" : "cmp.stagedMany", { count: status.stagedCount });
  const disabledReason = !connected ? t("cw.tConnect") : identityMissing ? t("id.blockedReason") : status.hasConflicts ? t("cw.tConflicts") : status.stagedCount === 0 ? t("cw.tStage") : !commit.summary.trim() ? t("cw.tMessage") : hasActiveRepositoryTask ? t("cw.tWait") : undefined;

  function handleSubmitShortcut(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): boolean {
    if (event.nativeEvent.isComposing) return false;
    const action: CommitAction | undefined = matchesShortcut(event.nativeEvent, shortcuts.commit, isMacPlatform)
      ? "commit"
      : matchesShortcut(event.nativeEvent, shortcuts.commitAndPush, isMacPlatform) ? "commitAndPush" : undefined;
    if (!action) return false;
    event.preventDefault();
    event.stopPropagation();
    onSubmit(action);
    return true;
  }

  return (
    <section className="commitComposer" onCompositionStartCapture={startComposition} onCompositionEndCapture={endComposition} onKeyDownCapture={guardImeKey} aria-label={t("cw.aria")}>
      <div className="composerOptions">
        <label className="disabledCheck"><input type="checkbox" checked={commit.amend} disabled={!repository?.head || commit.busy} onChange={(event) => onSelectAmend(event.target.checked)} /> {t("cw.amend")}</label>
        <label className="disabledCheck" title={t("cw.signOffHelp")}><input type="checkbox" aria-label={t("cw.signOff")} aria-describedby="commit-signoff-help" checked={commit.signOff} disabled={!repository || commit.busy} onChange={(event) => onSelectSignOff(event.target.checked)} /> <span className="composerLabelFull">{t("cw.signOff")}</span><span className="composerLabelCompact">{t("cw.signOffCompact")}</span></label>
        <label className="disabledCheck" title={t("cw.signHelp")}><input type="checkbox" aria-label={t("cw.sign")} aria-describedby="commit-sign-help" checked={commit.sign} disabled={!repository || commit.busy} onChange={(event) => onSelectSign(event.target.checked)} /> <span className="composerLabelFull">{t("cw.sign")}</span><span className="composerLabelCompact">{t("cw.signCompact")}</span></label>
        <span className="composerHeaderSpacer" />
        <button type="button" className="textButton commitAiTrigger" aria-label={t("cw.aiSuggestion", { shortcut: displayShortcut(shortcuts.aiCommitMessage, isMacPlatform) })} aria-keyshortcuts={ariaShortcut(shortcuts.aiCommitMessage, isMacPlatform)} disabled={!repository || status.stagedCount === 0 || status.hasConflicts || commit.busy} title={status.hasConflicts ? t("cw.aiResolve") : status.stagedCount === 0 ? t("cw.aiStage") : t("cw.aiReview", { shortcut: displayShortcut(shortcuts.aiCommitMessage, isMacPlatform) })} onClick={() => onAssistantOpenChange(!commit.assistantOpen)}><span className="composerLabelFull">{t("cw.aiSuggestion", { shortcut: displayShortcut(shortcuts.aiCommitMessage, isMacPlatform) })}</span><span className="composerLabelCompact">{t("cw.aiSuggestionCompact")}</span></button>
      </div>
      <p id="commit-signoff-help" className="srOnly">{t("cw.signOffHelp")}</p>
      <p id="commit-sign-help" className="srOnly">{t("cw.signHelp")}</p>
      <div className="commitSummaryField">
        <input
          id="commit-message"
          type="text"
          aria-label={t("cw.message")}
          aria-keyshortcuts={commitKeyShortcuts}
          aria-describedby="commit-summary-length"
          placeholder={t("cw.placeholder")}
          value={commit.summary}
          disabled={!repository || !connected || commit.busy}
          onChange={(event) => onChangeSummary(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (handleSubmitShortcut(event)) return;
            if (event.key === "Enter" && !event.nativeEvent.isComposing && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault();
              setDescriptionOpen(true);
              requestAnimationFrame(() => descriptionRef.current?.focus());
            }
          }}
        />
        <span id="commit-summary-length" className={`commitSummaryLength${summaryTooLong ? " over" : ""}`} title={t("cw.summaryLengthHint", { limit: SUMMARY_SOFT_LIMIT })}>{t("cw.summaryLength", { count: summaryLength, limit: SUMMARY_SOFT_LIMIT })}</span>
      </div>
      <details className="flowDisclosure composerDetails" open={descriptionOpen} onToggle={(event) => setDescriptionOpen(event.currentTarget.open)}>
      <summary>{t("ux.addDescription")}</summary><textarea
        id="commit-description"
        className="commitDescription"
        ref={descriptionRef}
        aria-label={t("cw.descriptionAria")}
        aria-keyshortcuts={commitKeyShortcuts}
        placeholder={t("cw.descriptionPlaceholder")}
        value={commit.description}
        rows={4}
        disabled={!repository || !connected || commit.busy}
        onChange={(event) => onChangeDescription(event.target.value)}
        onKeyDown={handleSubmitShortcut}
      />
      </details>
      {identityMissing && repository && api && <div className="commitAdvisory identityNotice" role="alert">
        <strong>{t("id.missingTitle")}</strong>
        <button type="button" className="textButton" aria-expanded={identityOpen} onClick={() => setIdentityOpen((open) => !open)}>{identityOpen ? t("id.hideEditor") : t("id.setIdentity")}</button>
        {identityOpen && <GitIdentityEditor api={api} repoId={repository.repoId} onSaved={onIdentitySaved} />}
      </div>}
      {commit.selections.length > 0 && <div className="commitSelectionNotice" role="status">{t(commit.selections.length === 1 ? "cw.selectionOne" : "cw.selectionMany", { count: commit.selections.length })} <button type="button" onClick={onClearSelections}>{t("cw.clearSelection")}</button></div>}
      {commit.assistantOpen && repository && api && <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">{t("cw.loadingTools")}</div>}><CommitMessageAssistant api={api} repoId={repository.repoId} draftMessage={commit.message} commitSelections={commit.selections} commitSelectionRepoId={commit.selectionRepoId} statusSnapshot={status.snapshot} onUseSuggestion={(message) => { onChangeTemplate("plain"); onChangeMessage(message); onAssistantOpenChange(false); }} onClose={() => onAssistantOpenChange(false)} /></Suspense>}
      {commit.amend && <p className="amendAdvisory" role="status">{t("cw.amendNote")}</p>}
      {status.sensitiveStagedPaths.length > 0 && <p className="commitAdvisory" role="status">{t("cw.sensitive", { paths: status.sensitiveStagedPaths.join(", ") })}</p>}
      {!commit.busy && <div className="composerNextStep" aria-live="polite">
        {!connected ? <span>{t("cw.tConnect")}</span>
          : hasActiveRepositoryTask ? <span>{t("cw.tWait")}</span>
          : status.hasConflicts ? onResolveConflicts ? <button type="button" className="textButton" onClick={onResolveConflicts}>{t("ux.conflictsNext")}</button> : <span>{t("cw.tConflicts")}</span>
          : !identityMissing && status.stagedCount === 0 && Boolean(status.workingCount) && onStageAll ? <><span>{t("ux.stageNext")}</span><button type="button" className="textButton" onClick={onStageAll}>{t("ux.stageAll")}</button></>
          : !identityMissing && status.stagedCount > 0 && !commit.summary.trim() ? <button type="button" className="textButton" onClick={() => document.getElementById("commit-message")?.focus()}>{t("ux.writeSummary")}</button>
          : null}
      </div>}
      <div className="composerActions">
        <div className={`commitSplit${commit.actionIsDanger ? " danger" : ""}`}>
          <button className="primaryButton commitButton" type="button" disabled={!commit.canCommit} title={disabledReason ?? (commit.actionIsDanger ? t("cw.tDanger") : t("cw.tRun"))} onClick={() => onSubmit(commit.activeAction)}>{commit.busy ? t("cw.submitting") : commit.actionLabel}</button>
          <button ref={actionButtonRef} className="commitSplitMenuButton" type="button" disabled={!repository || commit.busy} aria-label={t("cw.chooseAction")} aria-haspopup="menu" aria-expanded={commit.actionMenuOpen} onClick={onToggleActionMenu}><UiIcon name="chevronDown" /></button>
          {commit.actionMenuOpen && <div ref={actionMenuRef} tabIndex={-1} className="commitActionMenu" role="menu" aria-label={t("cw.actionsAria")} onKeyDown={(event) => navigateMenu(event, () => { onToggleActionMenu(); actionButtonRef.current?.focus(); })}>
            <button type="button" role="menuitemradio" aria-checked={commit.activeAction === "commit"} aria-keyshortcuts={ariaShortcut(shortcuts.commit, isMacPlatform)} disabled={!commit.canCommit} onClick={() => onChooseAction("commit")}><span>{t("cw.mCommit")}</span><kbd aria-hidden="true">{displayShortcut(shortcuts.commit, isMacPlatform)}</kbd></button>
            <button type="button" role="menuitemradio" aria-checked={commit.activeAction === "commitAndPush"} aria-keyshortcuts={ariaShortcut(shortcuts.commitAndPush, isMacPlatform)} disabled={!commit.canCommit} onClick={() => onChooseAction("commitAndPush")}><span>{t("cw.mCommitPush")}</span><kbd aria-hidden="true">{displayShortcut(shortcuts.commitAndPush, isMacPlatform)}</kbd></button>
            <button type="button" role="menuitemradio" aria-checked={commit.activeAction === "commitAndPushTo"} disabled={!commit.canCommit} onClick={() => onChooseAction("commitAndPushTo")}>{t("cw.mCommitPushTo")}</button>
            <button className="dangerMenuItem" type="button" role="menuitemradio" aria-checked={commit.activeAction === "commitAndPushForce"} disabled={!commit.canCommit} onClick={() => onChooseAction("commitAndPushForce")}>{t("cw.mForce")}</button>
          </div>}
        </div>
      </div>
      <div className="composerFooter">
        <p className="composerStatus"><span title={target}>{target}</span><span className={status.stagedCount === 0 ? "empty" : undefined}>{stagedLabel}</span></p>
          <label className="srOnly" htmlFor="commit-template">{t("cw.template")}</label>
          <SearchableSelect id="commit-template" className="composerTemplate" aria-label={t("cw.template")} value={commit.template} disabled={!repository || !connected || commit.busy} onChange={(event) => onChangeTemplate(event.target.value)}>
            <option value="plain">{t("cw.plain")}</option>
            <option value="conventional">{t("cw.conventional")}</option>
            <option value="fix">{t("cw.fix")}</option>
          </SearchableSelect>
      </div>
    </section>
  );
}

export default CommitWorkbench;
