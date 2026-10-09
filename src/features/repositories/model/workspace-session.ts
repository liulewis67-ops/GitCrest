import type { CommitAction } from "../../commits";

export type WorkspaceMode = "graph" | "diff";

export type RepositoryTabState = {
  mode: WorkspaceMode;
  selectedCommit?: string;
  selectedFilePath?: string;
  selectedFileScope?: "workingTree" | "index" | "commit";
  selectedDiffCommitOid?: string;
  graphScrollTop: number;
  commitAction?: CommitAction;
};

export type WorkspaceSession = {
  openRepoIds: string[];
  activeRepoId?: string;
  tabs: Record<string, RepositoryTabState>;
};

const WORKSPACE_SESSION_KEY = "gitcrest-workspace-session-v1";

function emptyWorkspaceSession(): WorkspaceSession {
  return { openRepoIds: [], tabs: {} };
}

export function parseWorkspaceSession(serialized: string | null): WorkspaceSession {
  try {
    const value: unknown = JSON.parse(serialized || "null");
    if (!value || typeof value !== "object") return emptyWorkspaceSession();
    const session = value as Partial<WorkspaceSession>;
    const openRepoIds = Array.isArray(session.openRepoIds)
      ? [...new Set(session.openRepoIds.filter((id): id is string => typeof id === "string"))]
      : [];
    const tabs: WorkspaceSession["tabs"] = {};
    if (session.tabs && typeof session.tabs === "object") {
      for (const [repoId, state] of Object.entries(session.tabs)) {
        if (!state || typeof state !== "object") continue;
        const candidate = state as Partial<RepositoryTabState>;
        tabs[repoId] = {
          mode: candidate.mode === "diff" ? "diff" : "graph",
          ...(typeof candidate.selectedCommit === "string" ? { selectedCommit: candidate.selectedCommit } : {}),
          ...(typeof candidate.selectedFilePath === "string" ? { selectedFilePath: candidate.selectedFilePath } : {}),
          ...(candidate.selectedFileScope === "workingTree" || candidate.selectedFileScope === "index" || candidate.selectedFileScope === "commit" ? { selectedFileScope: candidate.selectedFileScope } : {}),
          ...(typeof candidate.selectedDiffCommitOid === "string" ? { selectedDiffCommitOid: candidate.selectedDiffCommitOid } : {}),
          ...(candidate.commitAction === "commit" || candidate.commitAction === "commitAndPush" || candidate.commitAction === "commitAndPushTo" || candidate.commitAction === "commitAndPushForce" ? { commitAction: candidate.commitAction } : {}),
          graphScrollTop: typeof candidate.graphScrollTop === "number" && Number.isFinite(candidate.graphScrollTop)
            ? Math.max(0, candidate.graphScrollTop)
            : 0,
        };
      }
    }
    return {
      openRepoIds,
      ...(typeof session.activeRepoId === "string" ? { activeRepoId: session.activeRepoId } : {}),
      tabs,
    };
  } catch {
    return emptyWorkspaceSession();
  }
}

export function loadWorkspaceSession(): WorkspaceSession {
  try {
    return parseWorkspaceSession(window.localStorage.getItem(WORKSPACE_SESSION_KEY));
  } catch {
    return emptyWorkspaceSession();
  }
}

export function saveWorkspaceSession(session: WorkspaceSession): void {
  try {
    window.localStorage.setItem(WORKSPACE_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Repository tabs remain available for this session if local storage is unavailable.
  }
}
