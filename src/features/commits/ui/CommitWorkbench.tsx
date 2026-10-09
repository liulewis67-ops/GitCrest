import { lazy, Suspense, type KeyboardEvent } from "react";
import type { CommitRequest, GitCrestApiClient, RepositoryResponse, StatusSnapshotResponse } from "../../../api/client";
import { ariaShortcut, displayShortcut, matchesShortcut, type ShortcutPreferences } from "../../settings";
import type { CommitAction } from "../model/commit-action";

const CommitMessageAssistant = lazy(() => import("../../settings").then(({ CommitMessageAssistant }) => ({ default: CommitMessageAssistant })));

interface CommitWorkbenchProps {
  repository?: RepositoryResponse;
  status: {
    snapshot?: StatusSnapshotResponse;
    error?: string;
    loading: boolean;
    workingCount: number;
    stagedCount: number;
    hasConflicts: boolean;
    sensitiveStagedPaths: string[];
  };
  commit: {
    message: string;
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
  onChangeMessage: (message: string) => void;
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

export function CommitWorkbench({
  repository,
  status,
  commit,
  shortcuts,
  isMacPlatform,
  connected,
  hasActiveRepositoryTask,
  api,
  onChangeMessage,
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
  return (
    <section className="workbench" aria-label="Changes and commit">
      <div className="workbenchSection">
        <div className="workbenchTitle">Working tree <span className="countBadge">{status.snapshot ? status.workingCount : "—"}</span></div>
        <p>{!repository ? "No changed files" : status.loading && !status.snapshot ? "Reading working tree…" : status.error && !status.snapshot ? status.error : status.workingCount === 0 ? "Working tree clean" : "Unstaged changes"}</p>
        <small>{repository && status.loading ? "Refreshing repository status…" : repository && !status.snapshot && !status.error ? "Waiting for the first status snapshot." : "Working tree changes are read from Git."}</small>
      </div>
      <div className="workbenchSection stagedSection">
        <div className="workbenchTitle">Staged changes <span className="countBadge">{status.snapshot ? status.stagedCount : "—"}</span></div>
        <div className="stagedEmpty">{!status.snapshot ? status.error || "Waiting for repository status…" : status.stagedCount === 0 ? "Nothing staged" : `${status.stagedCount} staged file${status.stagedCount === 1 ? "" : "s"}`}</div>
        <small>Review staged files before the commit workflow becomes available.</small>
      </div>
      <div className="workbenchSection commitSection">
        <div className="commitMessageHeading">
          <label className="workbenchTitle" htmlFor="commit-message">Commit message</label>
          <button type="button" className="textButton commitAiTrigger" disabled={!repository || status.stagedCount === 0 || status.hasConflicts || commit.busy} title={status.hasConflicts ? "Resolve conflicts before requesting a commit suggestion" : status.stagedCount === 0 ? "Stage changes before requesting a suggestion" : `Review staged diffs before sending (${displayShortcut(shortcuts.aiCommitMessage, isMacPlatform)})`} onClick={() => onAssistantOpenChange(!commit.assistantOpen)}>AI suggestion · {displayShortcut(shortcuts.aiCommitMessage, isMacPlatform)}</button>
        </div>
        <label className="srOnly" htmlFor="commit-template">Message template</label>
        <select id="commit-template" aria-label="Message template" value={commit.template} disabled={!repository || !connected || commit.busy} onChange={(event) => onChangeTemplate(event.target.value)}>
          <option value="plain">Plain message</option>
          <option value="conventional">Conventional commit</option>
          <option value="fix">Fix</option>
        </select>
        <textarea
          id="commit-message"
          aria-label="Commit message"
          aria-keyshortcuts={`${ariaShortcut(shortcuts.commit, isMacPlatform)} ${ariaShortcut(shortcuts.commitAndPush, isMacPlatform)}`}
          placeholder="Describe the changes you want to commit…"
          value={commit.message}
          disabled={!repository || !connected || commit.busy}
          onChange={(event) => onChangeMessage(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (!event.nativeEvent.isComposing && matchesShortcut(event.nativeEvent, shortcuts.commit, isMacPlatform)) {
              event.preventDefault();
              event.stopPropagation();
              onSubmit("commit");
            } else if (!event.nativeEvent.isComposing && matchesShortcut(event.nativeEvent, shortcuts.commitAndPush, isMacPlatform)) {
              event.preventDefault();
              event.stopPropagation();
              onSubmit("commitAndPush");
            }
          }}
        />
        {commit.selections.length > 0 && <div className="commitSelectionNotice" role="status">{commit.selections.length} staged file selection{commit.selections.length === 1 ? "" : "s"} will be committed. Other staged changes stay in the index. <button type="button" onClick={onClearSelections}>Clear selection</button></div>}
        {commit.assistantOpen && repository && api && <Suspense fallback={<div className="dialogChunkLoading" role="status" aria-live="polite">Loading suggestion tools…</div>}><CommitMessageAssistant api={api} repoId={repository.repoId} draftMessage={commit.message} commitSelections={commit.selections} commitSelectionRepoId={commit.selectionRepoId} statusSnapshot={status.snapshot} onUseSuggestion={(message) => { onChangeTemplate("plain"); onChangeMessage(message); onAssistantOpenChange(false); }} onClose={() => onAssistantOpenChange(false)} /></Suspense>}
        <div className="commitControls">
          <div className="commitOptions">
            <label className="disabledCheck"><input type="checkbox" checked={commit.amend} disabled={!repository?.head || commit.busy} onChange={(event) => onSelectAmend(event.target.checked)} /> Amend</label>
            <label className="disabledCheck"><input type="checkbox" checked={commit.signOff} disabled={!repository || commit.busy} onChange={(event) => onSelectSignOff(event.target.checked)} /> Sign-off</label>
            <label className="disabledCheck"><input type="checkbox" checked={commit.sign} disabled={!repository || commit.busy} onChange={(event) => onSelectSign(event.target.checked)} /> Sign</label>
          </div>
          <div className={`commitSplit${commit.actionIsDanger ? " danger" : ""}`}>
            <button className="primaryButton commitButton" type="button" disabled={!commit.canCommit} title={!connected ? "Connect to the Git engine to commit" : status.hasConflicts ? "Resolve conflicts before committing" : status.stagedCount === 0 ? "Stage changes before committing" : !commit.message.trim() ? "Enter a commit message" : hasActiveRepositoryTask ? "Wait for the current repository task" : commit.actionIsDanger ? "Commit, then review the force-with-lease target and overwrite scope" : "Run the selected commit action"} onClick={() => onSubmit(commit.activeAction)}>{commit.busy ? "Submitting…" : commit.actionLabel}</button>
            <button className="commitSplitMenuButton" type="button" disabled={!repository || commit.busy} aria-label="Choose commit action" aria-haspopup="menu" aria-expanded={commit.actionMenuOpen} onClick={onToggleActionMenu}>▾</button>
            {commit.actionMenuOpen && <div className="commitActionMenu" role="menu" aria-label="Commit actions">
              <button type="button" role="menuitemradio" aria-checked={commit.activeAction === "commit"} disabled={!commit.canCommit} onClick={() => onChooseAction("commit")}>Commit</button>
              <button type="button" role="menuitemradio" aria-checked={commit.activeAction === "commitAndPush"} disabled={!commit.canCommit} onClick={() => onChooseAction("commitAndPush")}>Commit and Push</button>
              <button type="button" role="menuitemradio" aria-checked={commit.activeAction === "commitAndPushTo"} disabled={!commit.canCommit} onClick={() => onChooseAction("commitAndPushTo")}>Commit and Push to…</button>
              <button className="dangerMenuItem" type="button" role="menuitemradio" aria-checked={commit.activeAction === "commitAndPushForce"} disabled={!commit.canCommit} onClick={() => onChooseAction("commitAndPushForce")}>Commit and Push (force-with-lease)…</button>
            </div>}
          </div>
        </div>
        {commit.amend && <p className="amendAdvisory" role="status">Amend replaces the current HEAD commit and changes its ID.</p>}
        {status.sensitiveStagedPaths.length > 0 && <p className="commitAdvisory" role="status">Review sensitive staged files before committing: {status.sensitiveStagedPaths.join(", ")}</p>}
        <small>Use Ctrl+Enter to commit. Only staged changes are included.</small>
      </div>
    </section>
  );
}

export default CommitWorkbench;
