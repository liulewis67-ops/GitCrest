import type { CommitAction } from "../../commits";

/** The task a repository tab is showing: local changes, or commit history with its branches. */
export type WorkspaceMode = "changes" | "history";

export const WORKSPACE_MODES: readonly WorkspaceMode[] = ["changes", "history"];

export type RepositoryTabState = {
  mode: WorkspaceMode;
  selectedCommit?: string;
  /** Working-tree file open in Changes; never a historical file. */
  selectedFilePath?: string;
  selectedFileScope?: "workingTree" | "index";
  /** File of `selectedDiffCommitOid` open in History. */
  selectedCommitFilePath?: string;
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

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = "changes";

function emptyWorkspaceSession(): WorkspaceSession {
  return { openRepoIds: [], tabs: {} };
}

type StoredTabState = Partial<Omit<RepositoryTabState, "mode" | "selectedFileScope">> & { mode?: unknown; selectedFileScope?: unknown };

/** Sessions saved under older views ("graph", "diff", "branches"); map them onto the view that shows the same content. */
function parseMode(candidate: StoredTabState): WorkspaceMode {
  if (candidate.mode === "changes" || candidate.mode === "history") return candidate.mode;
  if (candidate.mode === "graph" || candidate.mode === "branches") return "history";
  if (candidate.mode === "diff") return candidate.selectedFileScope === "commit" ? "history" : "changes";
  return DEFAULT_WORKSPACE_MODE;
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
        const candidate = state as StoredTabState;
        const legacyCommitFile = candidate.selectedFileScope === "commit" && typeof candidate.selectedFilePath === "string";
        const workingFile = (candidate.selectedFileScope === "workingTree" || candidate.selectedFileScope === "index") && typeof candidate.selectedFilePath === "string";
        const commitFilePath = typeof candidate.selectedCommitFilePath === "string"
          ? candidate.selectedCommitFilePath
          : legacyCommitFile ? candidate.selectedFilePath : undefined;
        tabs[repoId] = {
          mode: parseMode(candidate),
          ...(typeof candidate.selectedCommit === "string" ? { selectedCommit: candidate.selectedCommit } : {}),
          ...(workingFile ? { selectedFilePath: candidate.selectedFilePath, selectedFileScope: candidate.selectedFileScope as "workingTree" | "index" } : {}),
          ...(commitFilePath ? { selectedCommitFilePath: commitFilePath } : {}),
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
