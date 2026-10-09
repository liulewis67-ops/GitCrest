import type { Dispatch, SetStateAction } from "react";
import type { RepositoryResponse } from "../../../api/client";
import type { WorkspaceMode, WorkspaceSession } from "./workspace-session";

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
          : { mode: "graph", selectedCommit: repository.head || undefined, graphScrollTop: 0 },
      },
    }));
  }

  function changeMode(repoId: string, mode: WorkspaceMode) {
    setSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [repoId]: {
          ...(current.tabs[repoId] || { graphScrollTop: 0 }),
          mode,
        },
      },
    }));
  }

  function openFileDiff(repoId: string, path: string, scope: "workingTree" | "index") {
    setSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [repoId]: {
          ...(current.tabs[repoId] || { graphScrollTop: 0 }),
          mode: "diff",
          selectedFilePath: path,
          selectedFileScope: scope,
          selectedDiffCommitOid: undefined,
        },
      },
    }));
  }

  function openCommitFileDiff(repoId: string, path: string, oid: string) {
    setSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [repoId]: {
          ...(current.tabs[repoId] || { graphScrollTop: 0 }),
          mode: "diff",
          selectedCommit: oid,
          selectedFilePath: path,
          selectedFileScope: "commit",
          selectedDiffCommitOid: oid,
        },
      },
    }));
  }

  return { activateRepository, changeMode, openFileDiff, openCommitFileDiff };
}
