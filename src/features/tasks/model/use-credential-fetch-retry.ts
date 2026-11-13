import { useEffect, useRef } from "react";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../../api/client";
import { onCredentialSaved } from "../../../shared/lib/credential-events";
import { isAuthenticationFailure } from "./task-operations";

interface CredentialFetchRetryOptions {
  tasks: TaskSnapshotResponse[];
  getApi: () => GitCrestApiClient | undefined;
  /** HTTPS hosts of a repository's remotes. */
  hostsForRepository: (repoId: string) => string[];
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
}

/**
 * Bounded retry after the user fixed a credential: each saved credential starts at most one fetch per repository
 * whose fetch failed on that host, and a failed task is never retried twice. Only fetches are retried; a push
 * needs its outcome reviewed first and is left to the user.
 */
export function useCredentialFetchRetry(options: CredentialFetchRetryOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const retried = useRef(new Set<string>());

  useEffect(() => onCredentialSaved((host) => {
    const current = latest.current;
    const api = current.getApi();
    if (!api) return;
    const started = new Set<string>();
    for (const task of current.tasks) {
      if (!task.repoId || !isAuthenticationFailure(task) || retried.current.has(task.taskId)) continue;
      if (!current.hostsForRepository(task.repoId).includes(host)) continue;
      retried.current.add(task.taskId);
      if (started.has(task.repoId)) continue;
      started.add(task.repoId);
      void api.fetchRepository(task.repoId).then(current.onTaskAccepted).catch(() => undefined);
    }
  }), []);
}
