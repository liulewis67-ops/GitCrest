import type { TaskSnapshotResponse } from "../../../api/client";

export function supportsWorkflowRecovery(operation: string): boolean {
  return ["merge", "cherryPick", "revert", "rebase", "pullMerge", "pullRebase"].includes(operation)
    || operation.startsWith("shelfApply:");
}

export function isAuthenticationFailure(task: TaskSnapshotResponse): boolean {
  if (task.status !== "failed" || task.operation !== "fetch") return false;
  if (task.errorCategory === "authentication") return true;
  return /authentication failed|authentication required|could not read username|could not read password|access denied|terminal prompts disabled/i.test([task.message, ...task.logs].join("\n"));
}

export function isFailedPush(task: TaskSnapshotResponse): boolean {
  return task.status === "failed" && task.operation.startsWith("push");
}
