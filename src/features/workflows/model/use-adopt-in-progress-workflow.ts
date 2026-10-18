import { useEffect, useRef } from "react";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../../api/client";

interface AdoptInProgressWorkflowOptions {
  getApi: () => GitCrestApiClient | undefined;
  repoId?: string;
  connected: boolean;
  onAdopted: (task: TaskSnapshotResponse) => void;
}

/**
 * When a repository is shown (and whenever the window regains focus), asks the engine to track a merge,
 * cherry-pick, revert or rebase that was started outside GitCrest or before a restart. The engine answers with
 * a waiting task, which brings the normal conflict resolver, Continue and Abort controls.
 */
export function useAdoptInProgressWorkflow({ getApi, repoId, connected, onAdopted }: AdoptInProgressWorkflowOptions) {
  const onAdoptedRef = useRef(onAdopted);
  const getApiRef = useRef(getApi);
  onAdoptedRef.current = onAdopted;
  getApiRef.current = getApi;

  useEffect(() => {
    if (!repoId || !connected) return;
    let cancelled = false;
    let inFlight = false;
    const adopt = async () => {
      const api = getApiRef.current();
      if (!api || inFlight) return;
      inFlight = true;
      try {
        const result = await api.adoptRepositoryWorkflow(repoId);
        if (!cancelled && result.adopted && result.task) onAdoptedRef.current(result.task);
      } catch {
        /* The probe is best effort; the regular task list still works without it. */
      } finally {
        inFlight = false;
      }
    };
    void adopt();
    window.addEventListener("focus", adopt);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", adopt);
    };
  }, [repoId, connected]);
}
