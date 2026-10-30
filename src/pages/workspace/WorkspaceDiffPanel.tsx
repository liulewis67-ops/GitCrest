import { useI18n } from "../../shared/i18n";
import { lazy, Suspense, useState } from "react";
import type { DiffDocumentResponse } from "../../api/client";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { LfsPointerNotice, lfsPointerChange, loadFileDiffViewer, loadSplitDiff, type CodeReviewSource, type DiffViewPreferences, type LfsAvailability } from "../../features/diff";

const SplitDiff = lazy(() => loadSplitDiff().then(({ SplitDiff }) => ({ default: SplitDiff })));
const FileDiffViewer = lazy(() => loadFileDiffViewer().then(({ FileDiffViewer }) => ({ default: FileDiffViewer })));

type Selection = Array<{ hunkIndex: number; rowIndex?: number; side?: "old" | "new" }>;

interface WorkspaceDiffPanelProps {
  path: string;
  scope: "workingTree" | "index" | "commit";
  /** A partly staged file has both an unstaged and a staged diff; this switches between them. */
  scopeOptions?: { available: Array<"workingTree" | "index">; onChange: (scope: "workingTree" | "index") => void };
  commitOid?: string;
  /** Status letter and kind shown before the path, for working-tree files. */
  status?: { code: string; kind: string };
  activeDiffKey: string;
  diffState: { key: string; loading: boolean; document?: DiffDocumentResponse; error?: string };
  /** The same file read in full, so the line view can group its changes by code structure. */
  structureSource?: { state: { key: string; loading: boolean; document?: DiffDocumentResponse; error?: string }; activeKey: string; retry: () => void };
  /** The file left the latest status snapshot. */
  fileMissing?: boolean;
  /** Staging, discarding and committing selected lines are blocked. */
  selectionDisabled: boolean;
  fileNavigation?: { index: number; total: number; onPrevious: () => void; onNext: () => void };
  focusMode: boolean;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  diffViewPreferences: DiffViewPreferences;
  onChangeDiffViewPreferences: (change: Partial<DiffViewPreferences>) => void;
  onToggleFocusMode: () => void;
  onRetryDiff: () => void;
  onStageSelection: (selections: Selection) => void;
  onDiscardSelection: (document: DiffDocumentResponse, selections: Selection) => void;
  onCommitSelection: (selections: Selection) => void;
  onOpenDiffWindow: (path: string, scope: "workingTree" | "index" | "commit", commitOid?: string) => void;
  /** Asks the core whether Git LFS is installed, for the note under an LFS pointer diff. */
  loadLfsAvailability?: () => Promise<LfsAvailability>;
}

/** The diff of one file, with its name, file-to-file navigation and focus mode above it. */
export function WorkspaceDiffPanel({
  path,
  scope,
  scopeOptions,
  commitOid,
  status,
  activeDiffKey,
  diffState,
  structureSource,
  fileMissing,
  selectionDisabled,
  fileNavigation,
  focusMode,
  shortcuts,
  isMacPlatform,
  diffViewPreferences,
  onChangeDiffViewPreferences,
  onToggleFocusMode,
  onRetryDiff,
  onStageSelection,
  onDiscardSelection,
  onCommitSelection,
  onOpenDiffWindow,
  loadLfsAvailability,
}: WorkspaceDiffPanelProps) {
  const { t } = useI18n();
  const slash = path.lastIndexOf("/");
  const directory = slash < 0 ? "" : path.slice(0, slash + 1);
  const name = slash < 0 ? path : path.slice(slash + 1);
  const scopeLabel = scope === "commit" ? undefined : scope === "index" ? t("grp.staged") : status?.kind === "untracked" ? t("grp.untracked") : t("grp.unstaged");
  const focusShortcut = displayShortcut(shortcuts.focusMode, isMacPlatform);
  const openWindow = () => onOpenDiffWindow(path, scope, commitOid);
  // A structure picked for staging in the full-file view, handed to the line view that opens next.
  const [pendingStructure, setPendingStructure] = useState<{ path: string; id: string } | null>(null);
  const structureState = structureSource && structureSource.state.key === structureSource.activeKey ? structureSource.state : undefined;
  const codeReview: CodeReviewSource | undefined = structureSource ? {
    fullDocument: structureState?.document,
    loading: !structureState || structureState.loading,
    error: structureState?.error,
    onRefresh: structureSource.retry,
    open: diffViewPreferences.structureOutline,
    onToggle: () => onChangeDiffViewPreferences({ structureOutline: !diffViewPreferences.structureOutline }),
    initialStructureId: pendingStructure?.path === path ? pendingStructure.id : undefined,
    onInitialStructureHandled: () => setPendingStructure(null),
  } : undefined;
  const structure = {
    onSelectForStaging: (selected: { id: string }) => {
      setPendingStructure({ path, id: selected.id });
      onChangeDiffViewPreferences({ layout: "hunks" });
    },
  };

  return (
    <section className="diffPanel" aria-label={t("main.fileDiff")}>
      <div className="diffPanelHeader">
        {status && <span className={`statusFileCode status-${status.kind}`} aria-label={status.kind}>{status.code}</span>}
        <span className="diffPanelPath" title={path}><strong>{name}</strong>{directory && <span className="diffPanelDirectory">{directory.slice(0, -1)}</span>}</span>
        {scopeOptions && scope !== "commit" ? <span className="diffScopeSwitch" role="group" aria-label={t("cp.diffScopeAria")}>
          {scopeOptions.available.map((option) => <button key={option} type="button" aria-pressed={option === scope} className={option === scope ? "active" : undefined} onClick={() => { if (option !== scope) scopeOptions.onChange(option); }}>{option === "index" ? t("grp.staged") : t("grp.unstaged")}</button>)}
        </span> : scopeLabel && <span className="diffScopeTag">{scopeLabel}</span>}
        <span className="diffPanelSpacer" />
        {fileNavigation && fileNavigation.total > 1 && <span className="diffFileNav" role="group" aria-label={t("chg.filePosition", { current: fileNavigation.index + 1, total: fileNavigation.total })}>
          <button className="quietButton compact iconButton" type="button" aria-label={t("chg.prevFile")} title={t("chg.prevFile")} disabled={fileNavigation.index <= 0} onClick={fileNavigation.onPrevious}><span aria-hidden="true">‹</span></button>
          <span className="diffFileNavPosition" aria-hidden="true">{t("chg.filePosition", { current: fileNavigation.index + 1, total: fileNavigation.total })}</span>
          <button className="quietButton compact iconButton" type="button" aria-label={t("chg.nextFile")} title={t("chg.nextFile")} disabled={fileNavigation.index >= fileNavigation.total - 1} onClick={fileNavigation.onNext}><span aria-hidden="true">›</span></button>
        </span>}
        {diffViewPreferences.layout === "hunks" && <span className="diffScopeSwitch" role="group" aria-label={t("sd.layoutAria")}>
          <button type="button" aria-pressed={diffViewPreferences.sideBySide} className={diffViewPreferences.sideBySide ? "active" : undefined} aria-keyshortcuts={ariaShortcut(shortcuts.toggleDiffView, isMacPlatform)} title={t("sd.layoutTitle", { shortcut: displayShortcut(shortcuts.toggleDiffView, isMacPlatform) })} onClick={() => onChangeDiffViewPreferences({ sideBySide: true })}>{t("dw.split")}</button>
          <button type="button" aria-pressed={!diffViewPreferences.sideBySide} className={!diffViewPreferences.sideBySide ? "active" : undefined} aria-keyshortcuts={ariaShortcut(shortcuts.toggleDiffView, isMacPlatform)} title={t("sd.layoutTitle", { shortcut: displayShortcut(shortcuts.toggleDiffView, isMacPlatform) })} onClick={() => onChangeDiffViewPreferences({ sideBySide: false })}>{t("dw.unified")}</button>
        </span>}
        <button className={`quietButton compact focusToggle${focusMode ? " active" : ""}`} type="button" aria-pressed={focusMode} aria-keyshortcuts={ariaShortcut(shortcuts.focusMode, isMacPlatform)} title={focusMode ? t("panel.exitFocusTitle", { shortcut: focusShortcut }) : t("panel.focusTitle", { shortcut: focusShortcut })} onClick={onToggleFocusMode}><span aria-hidden="true">{focusMode ? "⤡" : "⤢"}</span><span>{focusMode ? t("panel.exitFocus") : t("panel.focus")}</span></button>
      </div>
      {diffState.key !== activeDiffKey || (diffState.loading && !diffState.document) ? <div className="diffSpecialState" role="status"><span className="loadingSpinner" aria-hidden="true" />{t("main.readingDiff")}</div>
        : diffState.error ? <div className="diffSpecialState" role="alert"><p>{diffState.error}</p><button className="secondaryButton" type="button" onClick={onRetryDiff}>{t("main.retryDiff")}</button>{diffViewPreferences.layout === "full" && <button className="secondaryButton" type="button" onClick={() => onChangeDiffViewPreferences({ layout: "hunks" })}>{t("fd.hunks")}</button>}</div>
          : diffState.document && lfsPointerChange(diffState.document) ? <LfsPointerNotice change={lfsPointerChange(diffState.document)!} path={path} loadAvailability={loadLfsAvailability} />
          : diffState.document && diffViewPreferences.layout === "full" ? <div className="fileDiffViewport"><Suspense fallback={<div className="diffSpecialState" role="status" aria-live="polite">{t("main.loadingDiffViewer")}</div>}><FileDiffViewer document={diffState.document} commitOid={commitOid} preferences={diffViewPreferences} onChangePreferences={onChangeDiffViewPreferences} onShowHunks={() => onChangeDiffViewPreferences({ layout: "hunks" })} onOpenWindow={openWindow} structure={structure} /></Suspense></div>
            : diffState.document ? <div className="graphViewport"><Suspense fallback={<div className="diffSpecialState" role="status" aria-live="polite">{t("main.loadingDiffViewer")}</div>}><SplitDiff layout={diffViewPreferences.sideBySide ? "split" : "unified"} document={diffState.document} onStageSelection={onStageSelection} onDiscardSelection={diffState.document.scope === "workingTree" ? (selections) => onDiscardSelection(diffState.document!, selections) : undefined} onCommitSelection={onCommitSelection} onOpenWindow={openWindow} onShowFullFile={() => onChangeDiffViewPreferences({ layout: "full" })} disabled={diffState.document.scope === "commit" || selectionDisabled || diffState.loading} codeReview={codeReview} /></Suspense></div>
              : <div className="diffSpecialState" role="status"><p>{fileMissing ? t("main.fileGone") : t("main.preparingDiff")}</p></div>}
    </section>
  );
}
