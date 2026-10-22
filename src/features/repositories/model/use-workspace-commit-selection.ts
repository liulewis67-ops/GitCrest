import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { DEFAULT_WORKSPACE_MODE, type WorkspaceSession } from "./workspace-session";

export function useWorkspaceCommitSelection(
  repoId: string | undefined,
  head: string | null | undefined,
  session: WorkspaceSession,
  setSession: Dispatch<SetStateAction<WorkspaceSession>>,
) {
  const selectedCommit = repoId
    ? session.tabs[repoId]?.selectedCommit || head || undefined
    : undefined;

  const selectCommit = useCallback((oid: string) => {
    if (!repoId) return;
    setSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [repoId]: { ...(current.tabs[repoId] || { mode: DEFAULT_WORKSPACE_MODE, graphScrollTop: 0 }), selectedCommit: oid },
      },
    }));
  }, [repoId, setSession]);

  return { selectedCommit, selectCommit };
}
