import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { DEFAULT_WORKSPACE_MODE, type WorkspaceMode, type WorkspaceSession } from "./workspace-session";

export function useWorkspaceGraphScroll(
  repoId: string | undefined,
  mode: WorkspaceMode,
  setWorkspaceSession: Dispatch<SetStateAction<WorkspaceSession>>,
) {
  const pendingScrollRef = useRef<{ repoId: string; scrollTop: number }>();
  const timerRef = useRef<number>();

  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);

  return useCallback((scrollTop: number) => {
    if (!repoId || mode === "changes" || !Number.isFinite(scrollTop)) return;
    pendingScrollRef.current = { repoId, scrollTop: Math.max(0, scrollTop) };
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      const latest = pendingScrollRef.current;
      pendingScrollRef.current = undefined;
      if (!latest) return;
      setWorkspaceSession((current) => ({
        ...current,
        tabs: {
          ...current.tabs,
          [latest.repoId]: { ...(current.tabs[latest.repoId] || { mode: DEFAULT_WORKSPACE_MODE, graphScrollTop: 0 }), graphScrollTop: latest.scrollTop },
        },
      }));
    }, 120);
  }, [mode, repoId, setWorkspaceSession]);
}
