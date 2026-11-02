import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useState } from "react";
import {
  GitCrestApiError,
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";
import type { components } from "../../../api/schema";
import { withPreservedChanges } from "../../shelves";

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
  const [error, setError] = useState<DisplayError>("");

  async function refreshPreflight(targetRepoId = repoId) {
    const api = getApi();
    if (!api || !targetRepoId) return;
    setLoading(true);
    setError("");
    try {
      setPreflight(await api.preflightRepositoryPull(targetRepoId));
    } catch (requestError) {
      setPreflight(undefined);
      setError(describeApiError(requestError, t("err.pullPreview")));
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
    if (!api || !repoId || !preview || preview.repoId !== repoId || preview.hasConflicts || preview.operationInProgress || busy) return;
    setBusy(true);
    setError("");
    try {
      const pull = () => api.pullRepository(repoId, {
        expectedLocalOid: preview.localOid,
        expectedTrackingOid: preview.trackingOid,
        strategy,
      });
      if (preview.isClean) {
        onTaskAccepted(await pull());
        setOpen(false);
      } else {
        await withPreservedChanges(api, repoId, pull, (task) => {
          setOpen(false);
          onTaskAccepted(task);
        });
      }
    } catch (requestError) {
      setError(describeApiError(requestError, t("err.pullStart")));
      setOpen(true);
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
