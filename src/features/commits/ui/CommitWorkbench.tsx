import { useI18n } from "../../../shared/i18n";
import { lazy, Suspense, useRef, type KeyboardEvent } from "react";
import type { CommitRequest, GitCrestApiClient, RepositoryResponse, StatusSnapshotResponse } from "../../../api/client";
import { ariaShortcut, displayShortcut, matchesShortcut, type ShortcutPreferences } from "../../settings";
import type { CommitAction } from "../model/commit-action";

const CommitMessageAssistant = lazy(() => import("./CommitMessageAssistant").then(({ CommitMessageAssistant }) => ({ default: CommitMessageAssistant })));

// Git tooling commonly truncates subjects past 72 characters; this is advice, not a limit.
const SUMMARY_SOFT_LIMIT = 72;

interface CommitWorkbenchProps {
  repository?: RepositoryResponse;
  status: {
    snapshot?: StatusSnapshotResponse;
    stagedCount: number;
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
  /** Collapsed shows only the summary and the commit button; expanded adds the description and options. */
  expanded: boolean;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  api?: GitCrestApiClient;
  onExpandedChange: (expanded: boolean) => void;
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
}

/** Writes and submits a commit of the staged changes. Shown only in the Changes view, and only while there is something to commit. */
export function CommitWorkbench({
  repository,
  status,
  commit,
  expanded,
  shortcuts,
  isMacPlatform,
  connected,
  hasActiveRepositoryTask,
  api,
  onExpandedChange,
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
}: CommitWorkbenchProps) {
  const { t } = useI18n();
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const commitKeyShortcuts = `${ariaShortcut(shortcuts.commit, isMacPlatform)} ${ariaShortcut(shortcuts.commitAndPush, isMacPlatform)}`;
  const summaryLength = commit.summary.trim().length;
  const summaryTooLong = summaryLength > SUMMARY_SOFT_LIMIT;
  const target = repository?.detached ? t("cmp.titleDetached") : t("cmp.title", { branch: repository?.branch || t("page.unbornBranch") });
  const stagedLabel = status.stagedCount === 0 ? t("cmp.nothingStaged") : t(status.stagedCount === 1 ? "cmp.stagedOne" : "cmp.stagedMany", { count: status.stagedCount });
  const disabledReason = !connected ? t("cw.tConnect") : status.hasConflicts ? t("cw.tConflicts") : status.stagedCount === 0 ? t("cw.tStage") : !commit.summary.trim() ? t("cw.tMessage") : hasActiveRepositoryTask ? t("cw.tWait") : undefined;

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
    <section className={`commitComposer${expanded ? " expanded" : ""}`} aria-label={t("cw.aria")}>
      <div className="composerHeader">
        <span className="composerTarget" title={target}>{target}</span>
        <span className={`composerStaged${status.stagedCount === 0 ? " empty" : ""}`}>{stagedLabel}</span>
        <span className="composerHeaderSpacer" />
        {expanded && <>
          <label className="srOnly" htmlFor="commit-template">{t("cw.template")}</label>
          <select id="commit-template" className="composerTemplate" aria-label={t("cw.template")} value={commit.template} disabled={!repository || !connected || commit.busy} onChange={(event) => onChangeTemplate(event.target.value)}>
            <option value="plain">{t("cw.plain")}</option>
            <option value="conventional">{t("cw.conventional")}</option>
            <option value="fix">{t("cw.fix")}</option>
          </select>
          <button type="button" className="textButton commitAiTrigger" disabled={!repository || status.stagedCount === 0 || status.hasConflicts || commit.busy} title={status.hasConflicts ? t("cw.aiResolve") : status.stagedCount === 0 ? t("cw.aiStage") : t("cw.aiReview", { shortcut: displayShortcut(shortcuts.aiCommitMessage, isMacPlatform) })} onClick={() => onAssistantOpenChange(!commit.assistantOpen)}>{t("cw.aiSuggestion", { shortcut: displayShortcut(shortcuts.aiCommitMessage, isMacPlatform) })}</button>
        </>}
        <button className="quietButton compact iconButton composerToggle" type="button" aria-expanded={expanded} aria-controls="commit-composer-details" aria-label={expanded ? t("cmp.collapse") : t("cmp.expand")} title={expanded ? t("cmp.collapse") : t("cmp.expand")} onClick={() => onExpandedChange(!expanded)}><span aria-hidden="true">{expanded ? "▾" : "▴"}</span></button>
      </div>
      <div className="composerSummaryRow">
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
            onChange={(event) => {
              onChangeSummary(event.target.value);
              // Typing a summary opens the rest of the form; the field itself stays put, so focus is kept.
              if (!expanded && event.target.value.trim()) onExpandedChange(true);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (handleSubmitShortcut(event)) return;
              if (event.key === "Enter" && !event.nativeEvent.isComposing && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                if (!expanded) onExpandedChange(true);
                requestAnimationFrame(() => descriptionRef.current?.focus());
              }
            }}
          />
          <span id="commit-summary-length" className={`commitSummaryLength${summaryTooLong ? " over" : ""}`} title={t("cw.summaryLengthHint", { limit: SUMMARY_SOFT_LIMIT })}>{t("cw.summaryLength", { count: summaryLength, limit: SUMMARY_SOFT_LIMIT })}</span>
        </div>
        <div className={`commitSplit${commit.actionIsDanger ? " danger" : ""}`}>
          <button className="primaryButton commitButton" type="button" disabled={!commit.canCommit} title={disabledReason ?? (commit.actionIsDanger ? t("cw.tDanger") : t("cw.tRun"))} onClick={() => onSubmit(commit.activeAction)}>{commit.busy ? t("cw.submitting") : commit.actionLabel}</button>
          <button className="commitSplitMenuButton" type="button" disabled={!repository || commit.busy} aria-label={t("cw.chooseAction")} aria-haspopup="menu" aria-expanded={commit.actionMenuOpen} onClick={onToggleActionMenu}>▾</button>
          {commit.actionMenuOpen && <div className="commitActionMenu" role="menu" aria-label={t("cw.actionsAria")}>
            <button type="button" role="menuitemradio" aria-checked={commit.activeAction === "commit"} disabled={!commit.canCommit} onClick={() => onChooseAction("commit")}>{t("cw.mCommit")}</button>
            <button type="button" role="menuitemradio" aria-checked={commit.activeAction === "commitAndPush"} disabled={!commit.canCommit} onClick={() => onChooseAction("commitAndPush")}>{t("cw.mCommitPush")}</button>
            <button type="button" role="menuitemradio" aria-checked={commit.activeAction === "commitAndPushTo"} disabled={!commit.canCommit} onClick={() => onChooseAction("commitAndPushTo")}>{t("cw.mCommitPushTo")}</button>
            <button className="dangerMenuItem" type="button" role="menuitemradio" aria-checked={commit.activeAction === "commitAndPushForce"} disabled={!commit.canCommit} onClick={() => onChooseAction("commitAndPushForce")}>{t("cw.mForce")}</button>
          </div>}
        </div>
      </div>
      {expanded && <div className="composerDetails" id="commit-composer-details">
        <label className="commitDescriptionLabel" htmlFor="commit-description">{t("cw.description")} <span>{t("cw.optional")}</span></label>
        <textarea
          id="commit-description"
          ref={descriptionRef}
          aria-label={t("cw.descriptionAria")}
          aria-keyshortcuts={commitKeyShortcuts}
          placeholder={t("cw.descriptionPlaceholder")}
          value={commit.description}
          rows={3}
          disabled={!repository || !connected || commit.busy}
          onChange={(event) => onChangeDescription(event.target.value)}
          onKeyDown={handleSubmitShortcut}
        />
        {commit.selections.length > 0 && <div className="commitSelectionNotice" role="status">{t(commit.selections.length === 1 ? "cw.selectionOne" : "cw.selectionMany", { count: commit.selections.length })} <button type="button" onClick={onClearSelections}>{t("cw.clearSelection")}</button></div>}
        {commit.assistantOpen && repository && api && <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">{t("cw.loadingTools")}</div>}><CommitMessageAssistant api={api} repoId={repository.repoId} draftMessage={commit.message} commitSelections={commit.selections} commitSelectionRepoId={commit.selectionRepoId} statusSnapshot={status.snapshot} onUseSuggestion={(message) => { onChangeTemplate("plain"); onChangeMessage(message); onAssistantOpenChange(false); }} onClose={() => onAssistantOpenChange(false)} /></Suspense>}
        <div className="commitOptions">
          <label className="disabledCheck"><input type="checkbox" checked={commit.amend} disabled={!repository?.head || commit.busy} onChange={(event) => onSelectAmend(event.target.checked)} /> {t("cw.amend")}</label>
          <label className="disabledCheck"><input type="checkbox" checked={commit.signOff} disabled={!repository || commit.busy} onChange={(event) => onSelectSignOff(event.target.checked)} /> {t("cw.signOff")}</label>
          <label className="disabledCheck"><input type="checkbox" checked={commit.sign} disabled={!repository || commit.busy} onChange={(event) => onSelectSign(event.target.checked)} /> {t("cw.sign")}</label>
          <small className="composerHint">{t("cw.hint")}</small>
        </div>
      </div>}
      {commit.amend && <p className="amendAdvisory" role="status">{t("cw.amendNote")}</p>}
      {status.sensitiveStagedPaths.length > 0 && <p className="commitAdvisory" role="status">{t("cw.sensitive", { paths: status.sensitiveStagedPaths.join(", ") })}</p>}
    </section>
  );
}

export default CommitWorkbench;
