import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useState } from "react";
import {
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";

interface RemoteMutationsOptions {
  getApi: () => GitCrestApiClient | undefined;
  repoId?: string;
  isRepositoryOpen: (repoId: string) => boolean;
  getCacheGeneration: (repoId: string) => number;
  beginCacheRequest: (repoId: string) => number;
  finishCacheRequest: (repoId: string) => void;
  setRemoteError: (repoId: string, message: DisplayError) => void;
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
}

export function useRemoteMutations({
  getApi,
  repoId,
  isRepositoryOpen,
  getCacheGeneration,
  beginCacheRequest,
  finishCacheRequest,
  setRemoteError,
  onTaskAccepted,
}: RemoteMutationsOptions) {
  const [busy, setBusy] = useState(false);

  async function submitRemoteTask(
    targetRepoId: string,
    action: () => Promise<TaskSnapshotResponse>,
  ) {
    const requestGeneration = beginCacheRequest(targetRepoId);
    setBusy(true);
    setRemoteError(targetRepoId, "");
    try {
      const task = await action();
      onTaskAccepted(task);
    } catch (error) {
      if (isRepositoryOpen(targetRepoId) && getCacheGeneration(targetRepoId) === requestGeneration) {
        setRemoteError(targetRepoId, describeApiError(error, t("err.updateRemotes")));
      }
    } finally {
      setBusy(false);
      finishCacheRequest(targetRepoId);
    }
  }

  function submit(
    action: (api: GitCrestApiClient, repoId: string) => Promise<TaskSnapshotResponse>,
  ) {
    const api = getApi();
    if (api && repoId) void submitRemoteTask(repoId, () => action(api, repoId));
  }

  return {
    busy,
    addRepositoryRemote: (name: string, url: string) =>
      submit((api, targetRepoId) => api.addRepositoryRemote(targetRepoId, name, url)),
    setRepositoryRemoteUrl: (name: string, url: string) =>
      submit((api, targetRepoId) => api.setRepositoryRemoteUrl(targetRepoId, name, url)),
    deleteRepositoryRemote: (name: string) =>
      submit((api, targetRepoId) => api.deleteRepositoryRemote(targetRepoId, name)),
    setRepositoryDefaultRemote: (name: string | null) =>
      submit((api, targetRepoId) => api.setRepositoryDefaultRemote(targetRepoId, name)),
    setRepositoryBranchUpstream: (localBranch: string, remoteName: string, remoteBranch: string) =>
      submit((api, targetRepoId) => api.setRepositoryBranchUpstream(targetRepoId, localBranch, remoteName, remoteBranch)),
  };
}
