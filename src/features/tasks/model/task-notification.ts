import type { TaskSnapshotResponse } from "../../../api/client";

export interface TaskNotificationText {
  /** Which fixed message to show; the text is never taken from the task, which can carry URLs. */
  kind: "pushDone" | "pullDone" | "cloneDone" | "fetchNew" | "failed";
}

/** `git fetch` prints a line like `a1b2c3d..e4f5a6b main -> origin/main` for every ref it moved. */
const MOVED_REF = /(?:[0-9a-f]{7,}\.{2,3}[0-9a-f]{7,}|\[new (?:branch|tag|ref)\]|\[forced update\])\s+\S+\s+->\s+\S+/;

export function fetchBroughtNewRefs(task: Pick<TaskSnapshotResponse, "logs">): boolean {
  return task.logs.some((line) => MOVED_REF.test(line));
}

/**
 * What to tell the user when a task has just ended, or nothing. Only the end of the long operations
 * is worth a system notification: push, pull, clone, a fetch that brought something, and failures.
 */
export function notificationForFinishedTask(task: TaskSnapshotResponse): TaskNotificationText | undefined {
  if (task.status === "failed") {
    // A scheduled fetch fails quietly and is reported inside the app, not once per interval.
    return task.operation === "fetchBackground" ? undefined : { kind: "failed" };
  }
  if (task.status !== "succeeded") return undefined;
  if (task.operation.startsWith("push")) return { kind: "pushDone" };
  if (task.operation.startsWith("pull")) return { kind: "pullDone" };
  if (task.operation === "clone") return { kind: "cloneDone" };
  if (task.operation.startsWith("fetch") && fetchBroughtNewRefs(task)) return { kind: "fetchNew" };
  return undefined;
}
