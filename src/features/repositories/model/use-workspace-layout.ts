import { useEffect, useState } from "react";

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  } catch {
    return fallback;
  }
}

export function useWorkspaceLayout(repoId?: string) {
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber("gitcrest-sidebar-width", 236, 190, 340));
  const [detailsWidth, setDetailsWidth] = useState(() => readStoredNumber("gitcrest-details-width", 284, 220, 420));
  const [workbenchHeight, setWorkbenchHeight] = useState(() => readStoredNumber("gitcrest-workbench-height", 204, 144, 360));
  const [layoutLoadedFor, setLayoutLoadedFor] = useState<string>();

  useEffect(() => {
    if (!repoId) {
      setLayoutLoadedFor(undefined);
      return;
    }
    setLayoutLoadedFor(undefined);
    setSidebarWidth(readStoredNumber(`gitcrest-layout-${repoId}-sidebar-width`, readStoredNumber("gitcrest-sidebar-width", 236, 190, 340), 190, 340));
    setDetailsWidth(readStoredNumber(`gitcrest-layout-${repoId}-details-width`, readStoredNumber("gitcrest-details-width", 284, 220, 420), 220, 420));
    setWorkbenchHeight(readStoredNumber(`gitcrest-layout-${repoId}-workbench-height`, readStoredNumber("gitcrest-workbench-height", 204, 144, 360), 144, 360));
    setLayoutLoadedFor(repoId);
  }, [repoId]);

  useEffect(() => {
    if (!repoId || layoutLoadedFor !== repoId) return;
    try {
      window.localStorage.setItem(`gitcrest-layout-${repoId}-sidebar-width`, String(sidebarWidth));
      window.localStorage.setItem(`gitcrest-layout-${repoId}-details-width`, String(detailsWidth));
      window.localStorage.setItem(`gitcrest-layout-${repoId}-workbench-height`, String(workbenchHeight));
    } catch {
      // Layout resizing remains available for this session if storage is unavailable.
    }
  }, [layoutLoadedFor, repoId, sidebarWidth, detailsWidth, workbenchHeight]);

  return { sidebarWidth, setSidebarWidth, detailsWidth, setDetailsWidth, workbenchHeight, setWorkbenchHeight };
}
