import { useState } from "react";
import {
  GitCrestApiError,
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";
import type { components } from "../../../api/schema";

type PullStrategy = components["schemas"]["PullRequest"]["strategy"];

interface RepositoryPullOptions {
  getApi: () => GitCrestApiClient | undefined;
  repoId?: string;
  onSelectRepository: (repoId: string) => void;
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
  refreshRepositoryStatus: (repoId: string) => void;
}

export function useRepositoryPull({
  getApi,
  repoId,
  onSelectRepository,
  onTaskAccepted,
  refreshRepositoryStatus,
}: RepositoryPullOptions) {
  const [open, setOpen] = useState(false);
  const [preflight, setPreflight] = useState<components["schemas"]["PullPreflight"]>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refreshPreflight(targetRepoId = repoId) {
    const api = getApi();
    if (!api || !targetRepoId) return;
    setLoading(true);
    setError("");
    try {
      setPreflight(await api.preflightRepositoryPull(targetRepoId));
    } catch (requestError) {
      const message = requestError instanceof GitCrestApiError ? requestError.body.error.message : undefined;
      setPreflight(undefined);
      setError(message || (requestError instanceof Error ? requestError.message : "Could not preview the pull."));
    } finally {
      setLoading(false);
    }
  }

  function openDialog(targetRepoId = repoId) {
    if (!targetRepoId) return;
    onSelectRepository(targetRepoId);
    setOpen(true);
    void refreshPreflight(targetRepoId);
  }

  async function submit(strategy: PullStrategy) {
    const api = getApi();
    const preview = preflight;
    if (!api || !repoId || !preview || preview.repoId !== repoId || !preview.isClean || busy) return;
    setBusy(true);
    setError("");
    try {
      onTaskAccepted(await api.pullRepository(repoId, {
        expectedLocalOid: preview.localOid,
        expectedTrackingOid: preview.trackingOid,
        strategy,
      }));
      setOpen(false);
    } catch (requestError) {
      const message = requestError instanceof GitCrestApiError ? requestError.body.error.message : undefined;
      setError(message || (requestError instanceof Error ? requestError.message : "Could not start the pull task."));
      if (requestError instanceof GitCrestApiError && ["PULL_PREFLIGHT_STALE", "PULL_REQUIRES_CLEAN"].includes(requestError.body.error.code)) {
        void refreshPreflight(repoId);
        refreshRepositoryStatus(repoId);
      }
    } finally {
      setBusy(false);
    }
  }

  return { open, setOpen, preflight, loading, busy, error, refreshPreflight, openDialog, submit };
}
