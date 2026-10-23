import { useEffect, useState } from "react";

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  } catch {
    return fallback;
  }
}

// Wide enough for the Commit panel's file names and commit form.
export const SIDEBAR_WIDTH = { fallback: 340, min: 220, max: 640 } as const;
// History's commit graph sits above the selected commit's changes; the changes keep the rest of the height.
export const HISTORY_GRAPH_HEIGHT = { fallback: 320, min: 120, max: 1200 } as const;
export const DETAILS_WIDTH = { fallback: 304, min: 260, max: 440 } as const;
// The selected commit's file list beside its diff.
export const COMMIT_FILES_WIDTH = { fallback: 240, min: 160, max: 560 } as const;

export function useWorkspaceLayout(repoId?: string) {
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber("gitcrest-sidebar-width", SIDEBAR_WIDTH.fallback, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max));
  const [historyGraphHeight, setHistoryGraphHeight] = useState(() => readStoredNumber("gitcrest-history-graph-height", HISTORY_GRAPH_HEIGHT.fallback, HISTORY_GRAPH_HEIGHT.min, HISTORY_GRAPH_HEIGHT.max));
  const [detailsWidth, setDetailsWidth] = useState(() => readStoredNumber("gitcrest-details-width", DETAILS_WIDTH.fallback, DETAILS_WIDTH.min, DETAILS_WIDTH.max));
  const [commitFilesWidth, setCommitFilesWidth] = useState(() => readStoredNumber("gitcrest-commit-files-width", COMMIT_FILES_WIDTH.fallback, COMMIT_FILES_WIDTH.min, COMMIT_FILES_WIDTH.max));
  const [layoutLoadedFor, setLayoutLoadedFor] = useState<string>();

  useEffect(() => {
    if (!repoId) {
      setLayoutLoadedFor(undefined);
      return;
    }
    setLayoutLoadedFor(undefined);
    setSidebarWidth(readStoredNumber(`gitcrest-layout-${repoId}-sidebar-width`, readStoredNumber("gitcrest-sidebar-width", SIDEBAR_WIDTH.fallback, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max), SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max));
    setHistoryGraphHeight(readStoredNumber(`gitcrest-layout-${repoId}-history-graph-height`, readStoredNumber("gitcrest-history-graph-height", HISTORY_GRAPH_HEIGHT.fallback, HISTORY_GRAPH_HEIGHT.min, HISTORY_GRAPH_HEIGHT.max), HISTORY_GRAPH_HEIGHT.min, HISTORY_GRAPH_HEIGHT.max));
    setDetailsWidth(readStoredNumber(`gitcrest-layout-${repoId}-details-width`, readStoredNumber("gitcrest-details-width", DETAILS_WIDTH.fallback, DETAILS_WIDTH.min, DETAILS_WIDTH.max), DETAILS_WIDTH.min, DETAILS_WIDTH.max));
    setCommitFilesWidth(readStoredNumber(`gitcrest-layout-${repoId}-commit-files-width`, readStoredNumber("gitcrest-commit-files-width", COMMIT_FILES_WIDTH.fallback, COMMIT_FILES_WIDTH.min, COMMIT_FILES_WIDTH.max), COMMIT_FILES_WIDTH.min, COMMIT_FILES_WIDTH.max));
    setLayoutLoadedFor(repoId);
  }, [repoId]);

  useEffect(() => {
    if (!repoId || layoutLoadedFor !== repoId) return;
    try {
      window.localStorage.setItem(`gitcrest-layout-${repoId}-sidebar-width`, String(sidebarWidth));
      window.localStorage.setItem(`gitcrest-layout-${repoId}-history-graph-height`, String(historyGraphHeight));
      window.localStorage.setItem(`gitcrest-layout-${repoId}-details-width`, String(detailsWidth));
      window.localStorage.setItem(`gitcrest-layout-${repoId}-commit-files-width`, String(commitFilesWidth));
    } catch {
      // Layout resizing remains available for this session if storage is unavailable.
    }
  }, [layoutLoadedFor, repoId, sidebarWidth, historyGraphHeight, detailsWidth, commitFilesWidth]);

  return { sidebarWidth, setSidebarWidth, historyGraphHeight, setHistoryGraphHeight, detailsWidth, setDetailsWidth, commitFilesWidth, setCommitFilesWidth };
}
