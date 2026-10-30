import { useEffect, useRef } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";
import { t, type MessageKey } from "../../../shared/i18n";

/** Bulk staging changes many files at once, so it is the case worth an Undo; a single tick is not. */
const BULK_MESSAGES: Record<string, MessageKey> = {
  stageAll: "stn.stageAll",
  unstageAll: "stn.unstageAll",
  stagePaths: "stn.stagePaths",
  unstagePaths: "stn.unstagePaths",
};

export function bulkStagingMessage(operation: string): MessageKey | undefined {
  return BULK_MESSAGES[operation];
}

interface StagingNoticeOptions {
  tasks: TaskSnapshotResponse[];
  /** Shows a success notice with an Undo action. */
  announce: (message: string, undo: () => void) => void;
  /** Undoes the most recent undoable operation of the open repository. */
  undo: () => void;
  /** Only the open repository's own staging is announced. */
  repoId?: string;
}

/**
 * Says when a bulk stage or unstage has finished, with a way back. Only tasks seen running are
 * announced, so opening the app never replays old ones.
 */
export function useStagingNotices({ tasks, announce, undo, repoId }: StagingNoticeOptions) {
  const statuses = useRef<Map<string, TaskSnapshotResponse["status"]> | null>(null);
  const latest = useRef({ announce, undo, repoId });
  latest.current = { announce, undo, repoId };

  useEffect(() => {
    const previous = statuses.current;
    statuses.current = new Map(tasks.map((task) => [task.taskId, task.status]));
    if (!previous) return;
    for (const task of tasks) {
      const key = bulkStagingMessage(task.operation);
      const before = previous.get(task.taskId);
      const wasRunning = before === "queued" || before === "running";
      if (!key || !wasRunning || task.status !== "succeeded" || task.repoId !== latest.current.repoId) continue;
      latest.current.announce(t(key), latest.current.undo);
    }
  }, [tasks]);
}
