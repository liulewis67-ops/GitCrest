import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { CommitAction } from "../../commits";
import type { WorkspaceSession } from "./workspace-session";

export function useWorkspaceCommitAction(
  repoId: string | undefined,
  setSession: Dispatch<SetStateAction<WorkspaceSession>>,
) {
  return useCallback((action: CommitAction) => {
    if (!repoId) return;
    setSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [repoId]: {
          ...(current.tabs[repoId] || { mode: "graph", graphScrollTop: 0 }),
          commitAction: action,
        },
      },
    }));
  }, [repoId, setSession]);
}
