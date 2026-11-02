import { describe, expect, it } from "vitest";
import type { TaskSnapshotResponse } from "../../src/api/client";
import { TaskRefreshPlanner } from "../../src/features/tasks/model/task-refresh-planner";

function task(operation: string, status: TaskSnapshotResponse["status"] = "succeeded"): TaskSnapshotResponse {
  return { taskId: `task-${operation}`, repoId: "repo_a", operation, status } as TaskSnapshotResponse;
}

describe("task refresh planner", () => {
  it("refreshes remote information and history after a successful fetch", () => {
    expect(new TaskRefreshPlanner().takeTerminalTaskPlan(task("fetch"))).toMatchObject({ refreshBranches: true, refreshRemotes: true, refreshHistory: true });
    expect(new TaskRefreshPlanner().takeTerminalTaskPlan(task("fetch", "failed"))).toMatchObject({ refreshBranches: false, refreshRemotes: false, refreshHistory: false });
  });
  it.each(["worktreeCreate", "worktreeRemove", "worktreePrune"])("refreshes branches after %s, which changes where branches are checked out", (operation) => {
    expect(new TaskRefreshPlanner().takeTerminalTaskPlan(task(operation))).toMatchObject({ kind: "branch", repoId: "repo_a", refreshBranches: true });
  });

  it("plans each finished task once and ignores running ones", () => {
    const planner = new TaskRefreshPlanner();
    expect(planner.takeTerminalTaskPlan(task("worktreeRemove", "running"))).toBeUndefined();
    expect(planner.takeTerminalTaskPlan(task("worktreeRemove"))).toBeDefined();
    expect(planner.takeTerminalTaskPlan(task("worktreeRemove"))).toBeUndefined();
  });
});
