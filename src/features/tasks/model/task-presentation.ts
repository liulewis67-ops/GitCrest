import type { RepositoryResponse, TaskSnapshotResponse } from "../../../api/client";
import { getLocale, t, type MessageKey } from "../../../shared/i18n";
import { getRepositoryDisplayName } from "../../../shared/lib/repository-display-name";

const operations: Record<string, MessageKey> = {
  fetch: "tk.op.fetch", fetchBackground: "tk.op.fetchBackground", fetchPrune: "tk.op.fetchPrune",
  push: "tk.op.push", pushForceWithLease: "tk.op.pushForceWithLease", pullMerge: "tk.op.pullMerge", pullRebase: "tk.op.pullRebase", pullFastForward: "tk.op.pullFastForward",
  clone: "tk.op.clone", commit: "tk.op.commit", stageFile: "tk.op.stage", stagePaths: "tk.op.stage", stage: "tk.op.stage", stageAll: "tk.op.stage", stageHunks: "tk.op.stage", unstageFile: "tk.op.unstage", unstagePaths: "tk.op.unstage", unstage: "tk.op.unstage", unstageAll: "tk.op.unstage", unstageHunks: "tk.op.unstage", discardChanges: "tk.op.discard",
  branchCreate: "tk.op.branchCreate", branchRename: "tk.op.branchRename", branchDelete: "tk.op.branchDelete", branchSwitch: "tk.op.branchSwitch", branchSwitchRemote: "tk.op.branchSwitch", branchSwitchCommit: "tk.op.checkoutCommit",
  worktreeCreate: "tk.op.worktreeCreate", worktreeRemove: "tk.op.worktreeRemove", worktreePrune: "tk.op.worktreePrune",
  remoteAdd: "tk.op.remoteAdd", remoteDelete: "tk.op.remoteDelete", remoteSetUrl: "tk.op.remoteSetUrl", remoteSetDefault: "tk.op.remoteSetDefault", remoteSetUpstream: "tk.op.remoteSetUpstream", remoteBranchDelete: "tk.op.remoteBranchDelete",
  resolveConflicts: "cf.title", merge: "tk.op.merge", cherryPick: "tk.op.cherryPick", revert: "tk.op.revert", rebase: "tk.op.rebase", rebaseRollback: "tk.op.rebaseRollback", reset: "tk.op.reset", resetRestore: "tk.op.resetRestore",
  pushTag: "tk.op.pushTag", deleteRemoteTag: "tk.op.deleteRemoteTag", stashApply: "tk.op.stashApply", stashPop: "tk.op.stashPop", stashDrop: "tk.op.stashDrop",
  workflowConflictSave: "tk.op.conflictSave", workflowConflictResolved: "tk.op.conflictResolved",
  shelfCreate: "tk.op.shelfCreate", shelfDelete: "tk.op.shelfDelete", undoRecentOperation: "tk.op.undo",
  workflowContinue: "tk.op.workflowContinue", workflowSkip: "tk.op.workflowSkip", workflowAbort: "tk.op.workflowAbort",
};

const phases: Record<string, MessageKey> = {
  "Waiting for repository access": "tk.phase.queued", "Waiting for submodule access": "tk.phase.queued", "Waiting for worktree access": "tk.phase.queued", Starting: "tk.phase.starting",
  "Enumerating objects": "tk.phase.enumerating", "Receiving objects": "tk.phase.receiving", "Writing objects": "tk.phase.writing", "Compressing objects": "tk.phase.compressing", "Resolving deltas": "tk.phase.resolving",
  Complete: "tk.phase.complete", Completed: "tk.phase.complete", Failed: "tk.phase.failed", Cancelled: "tk.phase.cancelled", "Waiting for input": "tk.phase.waiting", Interrupted: "tk.phase.interrupted", Stopped: "tk.phase.stopped",
};

export function taskOperationLabel(operation: string): string {
  const key = operation.startsWith("shelfApply:") ? "tk.op.shelfApply" : Object.prototype.hasOwnProperty.call(operations, operation) ? operations[operation] : undefined;
  return t(key || (operation.startsWith("workflow") ? "tk.op.workflow" : "tk.op.other"));
}

export function taskPhaseLabel(phase: string): string {
  return t(Object.prototype.hasOwnProperty.call(phases, phase) ? phases[phase] : "tk.phase.working");
}

const failureHints: Record<NonNullable<TaskSnapshotResponse["failureCode"]>, MessageKey> = {
  LOCAL_CHANGES_WOULD_BE_OVERWRITTEN: "tk.failure.localChanges",
  UNTRACKED_FILES_WOULD_BE_OVERWRITTEN: "tk.failure.untrackedFiles",
  HISTORY_CONFLICT: "tk.failure.historyConflict",
  RESTORE_CONFLICT: "tk.failure.restoreConflict",
  GIT_OPERATION_PAUSED: "tk.failure.paused",
  AUTHENTICATION_FAILED: "tk.error.authentication",
  REMOTE_POLICY_REJECTED: "tk.failure.remotePolicy",
  LEASE_STALE: "tk.failure.leaseStale",
  PUSH_REJECTED: "tk.error.pushRejected",
  PRECONDITION_CHANGED: "tk.failure.preconditionChanged",
  OUTCOME_UNKNOWN: "tk.error.outcomeUnknown",
  GIT_UNAVAILABLE: "tk.error.gitUnavailable",
  NETWORK: "tk.error.network",
  TIMED_OUT: "tk.failure.timedOut",
  COMMAND_FAILED: "tk.error.commandFailed",
};

export function taskFailureHint(task: TaskSnapshotResponse): string | undefined {
  const key = task.failureCode && Object.prototype.hasOwnProperty.call(failureHints, task.failureCode)
    ? failureHints[task.failureCode]
    : task.errorCategory ? `tk.error.${task.errorCategory}` as const : undefined;
  return key ? t(key) : undefined;
}

export function taskOutcome(task: TaskSnapshotResponse): string {
  if (task.status === "succeeded") {
    if (task.operation.startsWith("fetch")) return t("tk.outcome.fetch");
    if (task.operation.startsWith("push")) return t("tk.outcome.push");
    if (task.operation === "clone") return t("tk.outcome.clone");
    if (task.operation === "commit") return t("tk.outcome.commit");
  }
  return t(`tk.outcome.${task.status}`, { operation: taskOperationLabel(task.operation) });
}

export function taskRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  if (Math.abs(seconds) < 60) return t("tk.justNow");
  const [divisor, unit] = Math.abs(seconds) < 3600 ? [60, "minute"] as const : Math.abs(seconds) < 86400 ? [3600, "hour"] as const : [86400, "day"] as const;
  return new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" }).format(Math.round(seconds / divisor), unit);
}

export function groupTasksByRepository(tasks: TaskSnapshotResponse[], repositories: RepositoryResponse[]) {
  const groups = new Map<string, { key: string; name: string; tasks: TaskSnapshotResponse[] }>();
  for (const task of [...tasks].sort((left, right) => right.createdAtMs - left.createdAtMs)) {
    const repoId = task.repoId || task.resultRepoId;
    const repository = repositories.find((entry) => entry.repoId === repoId);
    const key = repoId || task.targetPath || "unassigned";
    const group = groups.get(key) || { key, name: repository ? getRepositoryDisplayName(repository.path) : task.targetPath ? getRepositoryDisplayName(task.targetPath) : t("tk.repository"), tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  return [...groups.values()];
}
