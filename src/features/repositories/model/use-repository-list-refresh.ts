import { useRef, type Dispatch, type SetStateAction } from "react";
import type { GitCrestApiClient, RepositoryResponse } from "../../../api/client";

interface RepositoryListRefreshOptions {
  setRepositories: Dispatch<SetStateAction<RepositoryResponse[]>>;
  setSelectedRepository: Dispatch<SetStateAction<RepositoryResponse | undefined>>;
  restoreWorkspace: (repositories: RepositoryResponse[]) => void;
}

export function useRepositoryListRefresh({
  setRepositories,
  setSelectedRepository,
  restoreWorkspace,
}: RepositoryListRefreshOptions) {
  const refreshGenerationRef = useRef(0);

  async function refresh(api: GitCrestApiClient, restoreSavedWorkspace = false) {
    const generation = ++refreshGenerationRef.current;
    const repositories = await api.listRepositories();
    if (refreshGenerationRef.current !== generation) return;
    setRepositories(repositories);
    if (restoreSavedWorkspace) {
      restoreWorkspace(repositories);
      return;
    }
    setSelectedRepository((current) => repositories.find((repository) => repository.repoId === current?.repoId));
  }

  return { refresh };
}
