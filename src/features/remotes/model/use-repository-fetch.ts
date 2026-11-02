import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../../api/client";

interface RepositoryFetchOptions {
  getApi: () => GitCrestApiClient | undefined;
  repoId?: string;
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
  onError: (message: DisplayError) => void;
}

export function useRepositoryFetch({ getApi, repoId, onTaskAccepted, onError }: RepositoryFetchOptions) {
  async function startFetch(all: boolean, acceptTask = onTaskAccepted, reportError = onError) {
    const api = getApi();
    if (!api || !repoId) return;
    try {
      acceptTask(await (all ? api.fetchRepository(repoId, false, false, true) : api.fetchRepository(repoId)));
    } catch (error) {
      reportError(describeApiError(error, t("err.fetchStart")));
    }
  }

  return {
    fetchRepository: () => startFetch(false),
    fetchAllRemotes: (feedback?: Pick<Partial<RepositoryFetchOptions>, "onTaskAccepted" | "onError">) => startFetch(true, feedback?.onTaskAccepted, feedback?.onError),
  };
}
