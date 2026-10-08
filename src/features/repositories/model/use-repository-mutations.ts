import {
  type GitCrestApiClient,
  type RepositoryResponse,
} from "../../../api/client";

interface RepositoryMutationsOptions {
  getApi: () => GitCrestApiClient | undefined;
  onRepositoriesChanged: (update: (current: RepositoryResponse[]) => RepositoryResponse[]) => void;
  onRepositoryForgotten: (repoId: string) => void;
  setError: (message: string) => void;
}

export function useRepositoryMutations({
  getApi,
  onRepositoriesChanged,
  onRepositoryForgotten,
  setError,
}: RepositoryMutationsOptions) {
  async function toggleFavorite(repository: RepositoryResponse) {
    const api = getApi();
    if (!api) return;
    setError("");
    try {
      const updated = await api.setRepositoryFavorite(repository.repoId, !repository.isFavorite);
      onRepositoriesChanged((current) => current.map((item) => item.repoId === updated.repoId ? updated : item)
        .sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite) || right.lastAccessedAt - left.lastAccessedAt));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not update this favorite.");
    }
  }

  async function forgetRepository(repository: RepositoryResponse) {
    const api = getApi();
    if (!api) return;
    setError("");
    try {
      await api.forgetRepository(repository.repoId);
      onRepositoriesChanged((current) => current.filter((item) => item.repoId !== repository.repoId));
      onRepositoryForgotten(repository.repoId);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not remove this recent repository.");
    }
  }

  return { toggleFavorite, forgetRepository };
}
