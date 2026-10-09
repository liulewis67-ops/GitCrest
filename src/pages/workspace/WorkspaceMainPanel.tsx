import { lazy, Suspense, useEffect, type RefObject } from "react";
import type { DiffDocumentResponse, GitCrestApiClient, RepositoryResponse, StatusSnapshotResponse } from "../../api/client";
import type { WorkspaceSession } from "../../features/repositories";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { loadSplitDiff } from "../../features/diff";
import { isFullGitObjectId, loadCommitGraph } from "../../features/history";

const CommitGraph = lazy(loadCommitGraph);
const SplitDiff = lazy(() => loadSplitDiff().then(({ SplitDiff }) => ({ default: SplitDiff })));

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
}: WorkspaceMainPanelProps) {
  useEffect(() => {
    const viewport = graphViewportRef.current;
    if (viewport && mode === "graph" && repository) {
      viewport.scrollTop = workspaceSession.tabs[repository.repoId]?.graphScrollTop || 0;
    }
  }, [graphViewportRef, mode, repository?.repoId, workspaceSession.tabs]);

  return (
    <section className="mainPanel" aria-label={mode === "graph" ? "Commit graph" : "File diff"}>
      <div className="panelHeading mainPanelHeading"><div className="viewTitle"><span className="viewGlyph" aria-hidden="true">◌</span><span>{mode === "graph" ? "Commit graph" : "Diff viewer"}</span><span className="subtleTag">LOCAL</span></div><button className="quietButton compact" type="button" disabled={!repository || statusLoading} onClick={() => { if (repository) onRefreshStatus(repository.repoId, true); }} aria-keyshortcuts={ariaShortcut(shortcuts.refreshStatus, isMacPlatform)} aria-label={statusLoading ? "Refreshing working tree status" : "Refresh working tree status"} title={statusLoading ? "Refreshing working tree status" : `Refresh working tree status (${displayShortcut(shortcuts.refreshStatus, isMacPlatform)})`}>{statusLoading ? "Refreshing…" : "Refresh ↻"}</button></div>
      {mode === "graph" ? repository && api && isFullGitObjectId(repository.head) ? <Suspense fallback={<div className="graphViewport" role="status" aria-live="polite">Loading commit history…</div>}><CommitGraph
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
      /></Suspense> : <div className="graphViewport" ref={graphViewportRef} onScroll={(event) => onGraphScrollPosition(event.currentTarget.scrollTop)} role="region" aria-label="Commit graph view"><div className="graphEmpty">
        <div className="graphIllustration" aria-hidden="true"><div className="graphLine" /><span className="graphNode nodeOne" /><span className="graphNode nodeTwo" /><span className="graphNode nodeThree" /><span className="graphNode nodeFour" /></div>
        <p className="sectionEyebrow">A CLEAR VIEW OF YOUR HISTORY</p>
        <h2>{repository ? repository.head ? "Connecting to history…" : "No commits yet" : "Your commit graph starts here"}</h2>
        <p>{repository ? `${repository.path}${repository.branch ? ` · ${repository.branch}` : repository.detached ? " · detached HEAD" : " · unborn branch"}` : "Open a repository to explore commits, branches, and the changes that connect them."}</p>
        {!repository && <button className="secondaryButton" type="button" onClick={onOpenRepository} disabled={openingRepository}>Open repository <span aria-hidden="true">→</span></button>}
      </div></div>
        : !repository || !selectedFilePath || !selectedFileScope ? <div className="graphViewport"><div className="diffSpecialState"><h2>Choose a changed file</h2><p>Select a file from Changes to review its working tree or staged diff.</p></div></div>
          : diffState.key !== activeDiffKey || diffState.loading ? <div className="diffSpecialState" role="status"><span className="loadingSpinner" aria-hidden="true" />Reading file diff…</div>
            : diffState.error ? <div className="diffSpecialState" role="alert"><p>{diffState.error}</p><button className="secondaryButton" type="button" onClick={onRetryDiff}>Retry diff</button></div>
              : diffState.document ? <div className="graphViewport"><Suspense fallback={<div className="diffSpecialState" role="status" aria-live="polite">Loading diff viewer…</div>}><SplitDiff document={diffState.document} onStageSelection={onStageSelection} onDiscardSelection={diffState.document.scope === "workingTree" ? (selections) => onDiscardSelection(diffState.document!, selections) : undefined} onCommitSelection={onCommitSelection} onOpenWindow={() => onOpenDiffWindow(selectedFilePath, selectedFileScope ?? "workingTree", selectedDiffCommitOid)} disabled={diffState.document.scope === "commit" || stagingBusy || hasActiveStagingTask || commitBusy} /></Suspense></div>
                : <div className="graphViewport"><div className="diffSpecialState" role="status"><p>{selectedDiffFile ? "Preparing file diff…" : "This file is no longer in the latest change snapshot."}</p></div></div>}
      <div className="panelFooter mainPanelFooter"><span>History is read from your local repository</span><span className="footerSpacer" />{version || "Local engine"}</div>
    </section>
  );
}

export default WorkspaceMainPanel;
