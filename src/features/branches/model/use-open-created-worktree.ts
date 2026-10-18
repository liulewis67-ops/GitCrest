import { useEffect, useRef } from "react";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../../api/client";

interface OpenCreatedWorktreeOptions {
  tasks: TaskSnapshotResponse[];
  getApi: () => GitCrestApiClient | undefined;
  /** Opens the worktree folder as a repository tab. */
  openPath: (path: string) => void | Promise<void>;
  onOpened: () => void;
}

/**
 * Opens a worktree as its own repository tab as soon as the task that created it succeeds, so the new folder is
 * ready to work in without a trip to the Worktrees list. Only tasks this window saw while they were still running
 * are opened, which keeps finished tasks from an earlier session from reopening tabs.
 */
export function useOpenCreatedWorktree({ tasks, getApi, openPath, onOpened }: OpenCreatedWorktreeOptions) {
  const watching = useRef(new Set<string>());
  const handled = useRef(new Set<string>());
  const openPathRef = useRef(openPath);
  const onOpenedRef = useRef(onOpened);
  const getApiRef = useRef(getApi);
  openPathRef.current = openPath;
  onOpenedRef.current = onOpened;
  getApiRef.current = getApi;

  useEffect(() => {
    for (const task of tasks) {
      if (task.operation !== "worktreeCreate" || handled.current.has(task.taskId)) continue;
      if (task.status === "queued" || task.status === "running") {
        watching.current.add(task.taskId);
        continue;
      }
      if (task.status !== "succeeded" || !task.resultRepoId || !watching.current.has(task.taskId)) continue;
      handled.current.add(task.taskId);
      watching.current.delete(task.taskId);
      const api = getApiRef.current();
      const repoId = task.resultRepoId;
      if (!api) continue;
      void api.getRepository(repoId).then(async (repository) => {
        await openPathRef.current(repository.path);
        onOpenedRef.current();
      }).catch(() => {
        /* The worktree exists; it can still be opened from the Worktrees list. */
      });
    }
  }, [tasks]);
}
