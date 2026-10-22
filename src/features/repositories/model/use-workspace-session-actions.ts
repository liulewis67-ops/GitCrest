import type { Dispatch, SetStateAction } from "react";
import type { RepositoryResponse } from "../../../api/client";
import { DEFAULT_WORKSPACE_MODE, type RepositoryTabState, type WorkspaceMode, type WorkspaceSession } from "./workspace-session";

function updateTab(session: WorkspaceSession, repoId: string, change: Partial<RepositoryTabState>): WorkspaceSession {
  return {
    ...session,
    tabs: {
      ...session.tabs,
      [repoId]: {
        ...(session.tabs[repoId] || { mode: DEFAULT_WORKSPACE_MODE, graphScrollTop: 0 }),
        ...change,
      },
    },
  };
}

export function useWorkspaceSessionActions(setSession: Dispatch<SetStateAction<WorkspaceSession>>) {
  function activateRepository(repository: RepositoryResponse) {
    setSession((current) => ({
      ...current,
      openRepoIds: [...current.openRepoIds.filter((repoId) => repoId !== repository.repoId), repository.repoId],
      activeRepoId: repository.repoId,
      tabs: {
        ...current.tabs,
        [repository.repoId]: current.tabs[repository.repoId]
          ? { ...current.tabs[repository.repoId], selectedCommit: current.tabs[repository.repoId].selectedCommit || repository.head || undefined }
          : { mode: DEFAULT_WORKSPACE_MODE, selectedCommit: repository.head || undefined, graphScrollTop: 0 },
      },
    }));
  }

  function changeMode(repoId: string, mode: WorkspaceMode) {
    setSession((current) => updateTab(current, repoId, { mode }));
  }

  /** Opens a working-tree or staged file in Changes. History keeps its own file selection. */
  function openFileDiff(repoId: string, path: string, scope: "workingTree" | "index") {
    setSession((current) => updateTab(current, repoId, { mode: "changes", selectedFilePath: path, selectedFileScope: scope }));
  }

  /** Moves the Changes selection without switching views, e.g. after a status refresh. Undefined clears it. */
  function selectWorkingFile(repoId: string, selection?: { path: string; scope: "workingTree" | "index" }) {
    setSession((current) => updateTab(current, repoId, { selectedFilePath: selection?.path, selectedFileScope: selection?.scope }));
  }

  /** Opens one file of a commit in History and selects that commit. */
  function openCommitFileDiff(repoId: string, path: string, oid: string) {
    setSession((current) => updateTab(current, repoId, {
      mode: "history",
      selectedCommit: oid,
      selectedCommitFilePath: path,
      selectedDiffCommitOid: oid,
    }));
  }

  function closeTab(session: WorkspaceSession, repoId: string) {
    const openRepoIds = session.openRepoIds.filter((id) => id !== repoId);
    const closingActive = session.activeRepoId === repoId;
    const nextActiveRepoId = closingActive
      ? openRepoIds[openRepoIds.length - 1]
      : session.activeRepoId;
    return {
      session: { ...session, openRepoIds, activeRepoId: nextActiveRepoId },
      closingActive,
      nextActiveRepoId,
    };
  }

  function restoreAvailableRepositories(session: WorkspaceSession, repositories: RepositoryResponse[]) {
    const availableRepoIds = session.openRepoIds.filter((repoId) =>
      repositories.some((repository) => repository.repoId === repoId && repository.availability === "available"));
    const activeRepoId = session.activeRepoId && availableRepoIds.includes(session.activeRepoId)
      ? session.activeRepoId
      : availableRepoIds[availableRepoIds.length - 1];
    const activeRepository = repositories.find((repository) => repository.repoId === activeRepoId);
    return {
      session: { ...session, openRepoIds: availableRepoIds, activeRepoId },
      activeRepository,
    };
  }

  return { activateRepository, changeMode, openFileDiff, selectWorkingFile, openCommitFileDiff, closeTab, restoreAvailableRepositories };
}
