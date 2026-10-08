import { useState } from "react";
import {
  GitCrestApiError,
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";
import type { components } from "../../../api/schema";
import type { PushTarget } from "../PushTargetDialog";

interface RepositoryPushOptions {
  getApi: () => GitCrestApiClient | undefined;
  repoId?: string;
  onSelectRepository: (repoId: string) => void;
  onTaskAccepted: (task: TaskSnapshotResponse, target: PushTarget) => void;
}

export function useRepositoryPush({ getApi, repoId, onSelectRepository, onTaskAccepted }: RepositoryPushOptions) {
  const [open, setOpen] = useState(false);
  const [preflight, setPreflight] = useState<components["schemas"]["PushPreflight"]>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forceOnly, setForceOnly] = useState(false);
  const [target, setTarget] = useState<PushTarget>();

  async function refreshPreflight(targetRepoId = repoId, pushTarget: PushTarget | null = target || null) {
    const api = getApi();
    if (!api || !targetRepoId) return;
    setLoading(true);
    setError("");
    try {
      setPreflight(await api.preflightRepositoryPush(targetRepoId, pushTarget || undefined));
    } catch (requestError) {
      const message = requestError instanceof GitCrestApiError ? requestError.body.error.message : undefined;
      setPreflight(undefined);
      setError(message || (requestError instanceof Error ? requestError.message : "Could not preview the push."));
    } finally {
      setLoading(false);
    }
  }

  function openDialog(targetRepoId = repoId, pushTarget?: PushTarget, onlyForce = false) {
    if (!targetRepoId) return;
    onSelectRepository(targetRepoId);
    setTarget(pushTarget);
    setForceOnly(onlyForce);
    setOpen(true);
    void refreshPreflight(targetRepoId, pushTarget || null);
  }

  async function submit(forceWithLease: boolean) {
    const api = getApi();
    const preview = preflight;
    if (!api || !repoId || !preview || preview.repoId !== repoId || busy) return;
    setBusy(true);
    setError("");
    try {
      const task = await api.pushRepository(repoId, {
        expectedLocalOid: preview.localOid,
        expectedRemoteOid: preview.expectedRemoteOid,
        forceWithLease,
        remoteName: preview.remoteName,
        remoteBranch: preview.remoteBranch,
      });
      onTaskAccepted(task, { remoteName: preview.remoteName, remoteBranch: preview.remoteBranch });
      setOpen(false);
    } catch (requestError) {
      const message = requestError instanceof GitCrestApiError ? requestError.body.error.message : undefined;
      setError(message || (requestError instanceof Error ? requestError.message : "Could not start the push task."));
      if (requestError instanceof GitCrestApiError && requestError.body.error.code === "PUSH_PREFLIGHT_STALE") {
        void refreshPreflight(repoId, target || null);
      }
    } finally {
      setBusy(false);
    }
  }

  return {
    open,
    setOpen,
    preflight,
    setPreflight,
    loading,
    setLoading,
    busy,
    setBusy,
    error,
    setError,
    forceOnly,
    setForceOnly,
    target,
    setTarget,
    refreshPreflight,
    openDialog,
    submit,
  };
}
