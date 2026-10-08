import type { GitCrestApiClient, TaskSnapshotResponse } from "../../../api/client";

interface RepositoryFetchOptions {
  getApi: () => GitCrestApiClient | undefined;
  repoId?: string;
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
  onError: (message: string) => void;
}

export function useRepositoryFetch({ getApi, repoId, onTaskAccepted, onError }: RepositoryFetchOptions) {
  async function fetchRepository() {
    const api = getApi();
    if (!api || !repoId) return;
    try {
      onTaskAccepted(await api.fetchRepository(repoId));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not start a fetch task.");
    }
  }

  return { fetchRepository };
}
