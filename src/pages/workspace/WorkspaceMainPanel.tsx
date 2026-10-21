import { useI18n } from "../../shared/i18n";
import { lazy, Suspense, useEffect, type RefObject } from "react";
import type { DiffDocumentResponse, GitCrestApiClient, RepositoryResponse, StatusSnapshotResponse } from "../../api/client";
import type { WorkspaceSession } from "../../features/repositories";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { loadFileDiffViewer, loadSplitDiff, type DiffViewPreferences } from "../../features/diff";
import { isFullGitObjectId, loadCommitGraph } from "../../features/history";

const CommitGraph = lazy(loadCommitGraph);
const SplitDiff = lazy(() => loadSplitDiff().then(({ SplitDiff }) => ({ default: SplitDiff })));
const FileDiffViewer = lazy(() => loadFileDiffViewer().then(({ FileDiffViewer }) => ({ default: FileDiffViewer })));

interface WorkspaceMainPanelProps {
  mode: "graph" | "diff";
  repository?: RepositoryResponse;
  api?: GitCrestApiClient;
  statusLoading: boolean;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  selectedCommit?: string;
  workspaceSession: WorkspaceSession;
  historyRefreshKey: number;
  historySearchFocusRequest?: { repoId: string; sequence: number };
  graphViewportRef: RefObject<HTMLDivElement>;
  openingRepository: boolean;
  selectedFilePath?: string;
  selectedFileScope?: "workingTree" | "index" | "commit";
  selectedDiffCommitOid?: string;
  activeDiffKey: string;
  diffState: { key: string; loading: boolean; document?: DiffDocumentResponse; error?: string };
  selectedDiffFile?: StatusSnapshotResponse["files"][number];
  stagingBusy: boolean;
  hasActiveStagingTask: boolean;
  commitBusy: boolean;
  version?: string;
  onRefreshStatus: (repoId: string, forceRefresh?: boolean) => void;
  onFocusSearchHandled: (sequence: number) => void;
  onGraphScrollPosition: (scrollTop: number) => void;
  onSelectCommit: (oid: string) => void;
  onOpenRepository: () => void;
  onRetryDiff: () => void;
  onStageSelection: (selections: Array<{ hunkIndex: number; rowIndex?: number }>) => void;
  onDiscardSelection: (document: DiffDocumentResponse, selections: Array<{ hunkIndex: number; rowIndex?: number }>) => void;
  onCommitSelection: (selections: Array<{ hunkIndex: number; rowIndex?: number }>) => void;
  onOpenDiffWindow: (path: string, scope: "workingTree" | "index" | "commit", commitOid?: string) => void;
  diffViewPreferences: DiffViewPreferences;
  onChangeDiffViewPreferences: (change: Partial<DiffViewPreferences>) => void;
  onCloseDiff: () => void;
}

export function WorkspaceMainPanel({
  mode,
  repository,
  api,
  statusLoading,
  shortcuts,
  isMacPlatform,
  selectedCommit,
  workspaceSession,
  historyRefreshKey,
  historySearchFocusRequest,
  graphViewportRef,
  openingRepository,
  selectedFilePath,
  selectedFileScope,
  selectedDiffCommitOid,
  activeDiffKey,
  diffState,
  selectedDiffFile,
  stagingBusy,
  hasActiveStagingTask,
  commitBusy,
  version,
  onRefreshStatus,
  onFocusSearchHandled,
  onGraphScrollPosition,
  onSelectCommit,
  onOpenRepository,
  onRetryDiff,
  onStageSelection,
  onDiscardSelection,
  onCommitSelection,
  onOpenDiffWindow,
  diffViewPreferences,
  onChangeDiffViewPreferences,
  onCloseDiff,
}: WorkspaceMainPanelProps) {
  const { t } = useI18n();
  useEffect(() => {
    const viewport = graphViewportRef.current;
    if (viewport && mode === "graph" && repository) {
      viewport.scrollTop = workspaceSession.tabs[repository.repoId]?.graphScrollTop || 0;
    }
  }, [graphViewportRef, mode, repository?.repoId, workspaceSession.tabs]);

  return (
    <section className="mainPanel" aria-label={mode === "graph" ? t("main.commitGraph") : t("main.fileDiff")}>
      <div className="panelHeading mainPanelHeading"><div className="viewTitle"><span className="viewGlyph" aria-hidden="true">◌</span><span>{mode === "graph" ? t("main.commitGraph") : t("main.diffViewer")}</span>{mode === "diff" && selectedFilePath && <span className="viewTitleFile" title={selectedFilePath}>{selectedFilePath.split("/").pop()}</span>}<span className="subtleTag">{t("main.local")}</span></div><div className="mainPanelHeadingActions"><button className="quietButton compact" type="button" disabled={!repository || statusLoading} onClick={() => { if (repository) onRefreshStatus(repository.repoId, true); }} aria-keyshortcuts={ariaShortcut(shortcuts.refreshStatus, isMacPlatform)} aria-label={statusLoading ? t("main.refreshingLabel") : t("main.refreshLabel")} title={statusLoading ? t("main.refreshingLabel") : t("main.refreshTitle", { shortcut: displayShortcut(shortcuts.refreshStatus, isMacPlatform) })}>{statusLoading ? t("main.refreshing") : t("main.refresh")}</button>{mode === "diff" && <button className="quietButton compact mainPanelClose" type="button" aria-label={t("main.closeDiff")} title={t("main.closeDiff")} onClick={onCloseDiff}>✕</button>}</div></div>
      {mode === "graph" ? repository && api && isFullGitObjectId(repository.head) ? <Suspense fallback={<div className="graphViewport" role="status" aria-live="polite">{t("main.loadingHistory")}</div>}><CommitGraph
        key={repository.repoId}
        api={api}
        repoId={repository.repoId}
        selectedOid={selectedCommit}
        initialScrollTop={workspaceSession.tabs[repository.repoId]?.graphScrollTop || 0}
        refreshKey={historyRefreshKey}
        focusSearchRequest={historySearchFocusRequest}
        searchShortcut={ariaShortcut(shortcuts.searchCommits, isMacPlatform)}
        onFocusSearchHandled={onFocusSearchHandled}
        onScrollPosition={onGraphScrollPosition}
        onSelect={onSelectCommit}
      /></Suspense> : <div className="graphViewport" ref={graphViewportRef} onScroll={(event) => onGraphScrollPosition(event.currentTarget.scrollTop)} role="region" aria-label={t("main.graphView")}><div className="graphEmpty">
        <div className="graphIllustration" aria-hidden="true"><div className="graphLine" /><span className="graphNode nodeOne" /><span className="graphNode nodeTwo" /><span className="graphNode nodeThree" /><span className="graphNode nodeFour" /></div>
        <p className="sectionEyebrow">{t("main.clearView")}</p>
        <h2>{repository ? repository.head ? t("main.connectingHistory") : t("main.noCommitsYet") : t("main.graphStartsHere")}</h2>
        <p>{repository ? `${repository.path}${repository.branch ? ` · ${repository.branch}` : repository.detached ? t("main.detachedSuffix") : t("main.unbornSuffix")}` : t("main.openToExplore")}</p>
        {!repository && <button className="secondaryButton" type="button" onClick={onOpenRepository} disabled={openingRepository}>{t("main.openRepository")} <span aria-hidden="true">→</span></button>}
      </div></div>
        : !repository || !selectedFilePath || !selectedFileScope ? <div className="graphViewport"><div className="diffSpecialState"><h2>{t("main.chooseFile")}</h2><p>{t("main.chooseFileHint")}</p></div></div>
          : diffState.key !== activeDiffKey || diffState.loading ? <div className="diffSpecialState" role="status"><span className="loadingSpinner" aria-hidden="true" />{t("main.readingDiff")}</div>
            : diffState.error ? <div className="diffSpecialState" role="alert"><p>{diffState.error}</p><button className="secondaryButton" type="button" onClick={onRetryDiff}>{t("main.retryDiff")}</button>{diffViewPreferences.layout === "full" && <button className="secondaryButton" type="button" onClick={() => onChangeDiffViewPreferences({ layout: "hunks" })}>{t("fd.hunks")}</button>}</div>
              : diffState.document && diffViewPreferences.layout === "full" ? <div className="fileDiffViewport"><Suspense fallback={<div className="diffSpecialState" role="status" aria-live="polite">{t("main.loadingDiffViewer")}</div>}><FileDiffViewer document={diffState.document} commitOid={selectedDiffCommitOid} preferences={diffViewPreferences} onChangePreferences={onChangeDiffViewPreferences} onShowHunks={() => onChangeDiffViewPreferences({ layout: "hunks" })} onOpenWindow={() => onOpenDiffWindow(selectedFilePath, selectedFileScope ?? "workingTree", selectedDiffCommitOid)} /></Suspense></div>
              : diffState.document ? <div className="graphViewport"><Suspense fallback={<div className="diffSpecialState" role="status" aria-live="polite">{t("main.loadingDiffViewer")}</div>}><SplitDiff document={diffState.document} onStageSelection={onStageSelection} onDiscardSelection={diffState.document.scope === "workingTree" ? (selections) => onDiscardSelection(diffState.document!, selections) : undefined} onCommitSelection={onCommitSelection} onOpenWindow={() => onOpenDiffWindow(selectedFilePath, selectedFileScope ?? "workingTree", selectedDiffCommitOid)} onShowFullFile={() => onChangeDiffViewPreferences({ layout: "full" })} disabled={diffState.document.scope === "commit" || stagingBusy || hasActiveStagingTask || commitBusy} /></Suspense></div>
                : <div className="graphViewport"><div className="diffSpecialState" role="status"><p>{selectedDiffFile ? t("main.preparingDiff") : t("main.fileGone")}</p></div></div>}
      <div className="panelFooter mainPanelFooter"><span>{t("main.historyLocal")}</span><span className="footerSpacer" />{version || t("welcome.localEngine")}</div>
    </section>
  );
}

export default WorkspaceMainPanel;
