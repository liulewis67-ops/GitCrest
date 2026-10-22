import { useEffect, useState } from "react";

/**
 * Counts the core restarts the main process reports. A window that keeps its own API client adds
 * this to the dependencies of the effect that connects, so it connects again to the new core.
 */
export function useCoreRestartCount(): number {
  const [restarts, setRestarts] = useState(0);
  useEffect(() => {
    const subscribe = typeof window === "undefined" ? undefined : window.gitcrest?.subscribeToCoreStatus;
    return subscribe?.((status) => {
      if (status.state === "ready") setRestarts((count) => count + 1);
    });
  }, []);
  return restarts;
}
