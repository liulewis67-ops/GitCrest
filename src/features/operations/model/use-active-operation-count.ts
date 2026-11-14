import { useEffect, useRef, useState } from "react";
import type { GitCrestApiClient, RepoId } from "../../../api/client";

/**
 * How many durable operations of a repository are still active. They survive closing the app and wait between
 * steps with no task running, so this is how the shell can tell the user one is waiting. Re-read when the
 * repository or `refreshToken` changes and when the window regains focus; a failed read keeps the last count.
 */
export function useActiveOperationCount(getApi: () => GitCrestApiClient | undefined, repoId: RepoId | undefined, refreshToken = ""): number {
  const [count, setCount] = useState(0);
  const generation = useRef(0);
  const getApiRef = useRef(getApi);
  getApiRef.current = getApi;

  useEffect(() => {
    setCount(0);
    if (!repoId) return;
    let stopped = false;
    const controllers = new Set<AbortController>();
    const refresh = () => {
      const api = getApiRef.current();
      if (!api) return;
      const mine = ++generation.current;
      const controller = new AbortController();
      controllers.add(controller);
      api.withSignal(controller.signal).listActiveRepositoryOperations(repoId).then((operations) => {
        if (!stopped && !controller.signal.aborted && generation.current === mine) setCount(operations.length);
      }).catch(() => undefined).finally(() => controllers.delete(controller));
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      stopped = true;
      window.removeEventListener("focus", refresh);
      for (const controller of controllers) controller.abort();
    };
  }, [repoId, refreshToken]);

  return count;
}
