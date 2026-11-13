import type { TaskSnapshotResponse } from "../../../api/client";
import { supportsWorkflowRecovery } from "./task-operations";

export type TaskRefreshKind = "staging" | "commit" | "branch" | "remote" | "push" | "pull" | "fetch" | "workflow" | "operation";

export interface TaskRepositoryRefreshPlan {
  kind: TaskRefreshKind;
  repoId?: string;
  refreshStatus: boolean;
  refreshBranches: boolean;
  refreshRemotes: boolean;
  refreshHistory: boolean;
  refreshRepository: boolean;
  reportRepositoryRefreshError: boolean;
}

const WORKFLOW_OPERATIONS = ["resolveConflicts", "merge", "cherryPick", "revert", "rebase", "rebaseRollback", "reset", "resetRestore", "remoteBranchDelete"];

export class TaskRefreshPlanner {
  private readonly refreshedTaskIds = new Map<TaskRefreshKind, Set<string>>();
  private readonly refreshedWorkflowInputTaskIds = new Set<string>();

  shouldRefreshWorkflowInput(task: TaskSnapshotResponse): boolean {
    if (task.status !== "waitingForInput" || !task.repoId || !supportsWorkflowRecovery(task.operation)) return false;
    if (this.refreshedWorkflowInputTaskIds.has(task.taskId)) return false;
    this.refreshedWorkflowInputTaskIds.add(task.taskId);
    return true;
  }

  takeTerminalTaskPlan(task: TaskSnapshotResponse): TaskRepositoryRefreshPlan | undefined {
    if (!["succeeded", "failed", "cancelled"].includes(task.status)) return undefined;

    let kind: TaskRefreshKind | undefined;
    if (task.operation === "operationAction") {
      // A durable operation action can move HEAD, branches, the index, history and shelves, so everything refreshes.
      kind = "operation";
    } else if (task.operation.startsWith("stage") || task.operation.startsWith("unstage") || task.operation === "discardChanges") {
      kind = "staging";
    } else if (task.operation === "commit") {
      kind = "commit";
    } else if (task.operation.startsWith("branch") || task.operation.startsWith("worktree")) {
      // Worktree tasks change which branches are checked out where, which the branch list shows.
      kind = "branch";
    } else if (task.operation.startsWith("remote")) {
      kind = "remote";
    } else if (task.operation.startsWith("push")) {
      kind = "push";
    } else if (task.operation.startsWith("pull")) {
      kind = "pull";
    } else if (task.operation.startsWith("fetch")) {
      kind = "fetch";
    } else if (task.operation.startsWith("workflow") || task.operation.startsWith("shelfApply:") || WORKFLOW_OPERATIONS.includes(task.operation)) {
      kind = "workflow";
    }
    if (!kind) return undefined;

    const refreshedIds = this.refreshedTaskIds.get(kind) || new Set<string>();
    if (refreshedIds.has(task.taskId)) return undefined;
    refreshedIds.add(task.taskId);
    this.refreshedTaskIds.set(kind, refreshedIds);

    const succeeded = task.status === "succeeded";
    return {
      kind,
      repoId: task.repoId || undefined,
      refreshStatus: kind === "staging" || kind === "commit" || kind === "pull" || kind === "workflow" || kind === "operation",
      refreshBranches: kind === "branch" || kind === "pull" || kind === "workflow" || kind === "operation"
        || ((kind === "push" || kind === "fetch") && succeeded)
        || (kind === "remote" && task.operation === "remoteSetUpstream"),
      refreshRemotes: kind === "remote" || (kind === "fetch" && succeeded),
      refreshHistory: kind === "pull" || kind === "workflow" || kind === "operation" || ((kind === "push" || kind === "fetch") && succeeded),
      refreshRepository: kind === "commit" || kind === "branch" || kind === "pull" || kind === "workflow" || kind === "operation",
      reportRepositoryRefreshError: kind === "commit",
    };
  }
}
