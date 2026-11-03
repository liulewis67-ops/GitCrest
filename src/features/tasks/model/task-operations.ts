import type { TaskSnapshotResponse } from "../../../api/client";

export function supportsWorkflowRecovery(operation: string): boolean {
  return ["resolveConflicts", "merge", "cherryPick", "revert", "rebase", "pullMerge", "pullRebase"].includes(operation)
    || operation.startsWith("shelfApply:");
}

export function isAuthenticationFailure(task: TaskSnapshotResponse): boolean {
  if (task.status !== "failed" || task.operation !== "fetch" && task.operation !== "fetchBackground") return false;
  if (task.errorCategory === "authentication") return true;
  return /authentication failed|authentication required|could not read username|could not read password|access denied|terminal prompts disabled/i.test([task.message, ...task.logs].join("\n"));
}

/** What Git and its signing tools print when a commit cannot be signed. */
const SIGNING_FAILURE = /gpg failed to sign|failed to write commit object|couldn't load (?:public )?key|load key ".*": |no secret key|ssh-keygen.*(?:fail|error|usage)|signing failed|error: cannot spawn |couldn't get agent socket|error: gpg\.ssh|cannot run gpg|gpg: .*(?:failed|error|no)|gpgsm: |agent refused operation|incorrect passphrase|bad passphrase/i;

export function isSigningFailure(task: TaskSnapshotResponse): boolean {
  if (task.status !== "failed" || !task.operation.startsWith("commit")) return false;
  return SIGNING_FAILURE.test([task.message ?? "", ...task.logs].join("\n"));
}

/** The lines of the task's output that come from the signing tools, as they were printed. */
export function signingFailureOutput(task: TaskSnapshotResponse): string {
  return task.logs.filter((line) => SIGNING_FAILURE.test(line)).slice(0, 8).join("\n");
}

export function isFailedPush(task: TaskSnapshotResponse): boolean {
  return task.status === "failed" && task.operation.startsWith("push");
}
