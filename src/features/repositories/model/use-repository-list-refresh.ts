import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { GitCrestApiClient, RepositoryResponse } from "../../../api/client";
import type { WorkspaceSession } from "./workspace-session";

interface RepositoryListRefreshOptions {
  setRepositories: Dispatch<SetStateAction<RepositoryResponse[]>>;
  setSelectedRepository: Dispatch<SetStateAction<RepositoryResponse | undefined>>;
  sessionRef: MutableRefObject<WorkspaceSession>;
  setSession: Dispatch<SetStateAction<WorkspaceSession>>;
  restoreAvailableRepositories: (session: WorkspaceSession, repositories: RepositoryResponse[]) => {
    session: WorkspaceSession;
    activeRepository?: RepositoryResponse;
  };
  setPage: (page: "welcome" | "workspace") => void;
}

export function useRepositoryListRefresh({
  setRepositories,
  setSelectedRepository,
  sessionRef,
  setSession,
  restoreAvailableRepositories,
  setPage,
}: RepositoryListRefreshOptions) {
  const refreshGenerationRef = useRef(0);
  const restoreWorkspacePendingRef = useRef(false);

  function registerOpenedRepository(repository: RepositoryResponse, sortByRecentAccess = false) {
    setRepositories((current) => {
      const next = [repository, ...current.filter((item) => item.repoId !== repository.repoId)];
      return sortByRecentAccess
        ? next.sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite) || right.lastAccessedAt - left.lastAccessedAt)
        : next;
    });
  }

  async function refresh(api: GitCrestApiClient, restoreSavedWorkspace = false) {
    if (restoreSavedWorkspace) restoreWorkspacePendingRef.current = true;
    const generation = ++refreshGenerationRef.current;
    const repositories = await api.listRepositories();
    if (refreshGenerationRef.current !== generation) return;
    setRepositories(repositories);
    if (restoreWorkspacePendingRef.current) {
      restoreWorkspacePendingRef.current = false;
      const restored = restoreAvailableRepositories(sessionRef.current, repositories);
      sessionRef.current = restored.session;
      setSession(restored.session);
      setSelectedRepository(restored.activeRepository);
      setPage(restored.activeRepository ? "workspace" : "welcome");
      return;
    }
    setSelectedRepository((current) => repositories.find((repository) => repository.repoId === current?.repoId));
  }

  return { refresh, registerOpenedRepository };
}
