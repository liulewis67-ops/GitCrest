import { afterEach, expect, it } from "vitest";
import type { RepositoryResponse, TaskSnapshotResponse } from "../../src/api/client";
import { setLocale } from "../../src/shared/i18n";
import { groupTasksByRepository, taskFailureHint, taskOperationLabel, taskOutcome, taskPhaseLabel, taskRelativeTime } from "../../src/features/tasks/model/task-presentation";
import { isAuthenticationFailure } from "../../src/features/tasks/model/task-operations";

afterEach(() => setLocale("en"));

const task: TaskSnapshotResponse = { taskId: "task", repoId: "repo_opaque", targetPath: null, resultRepoId: null, operation: "fetch", status: "succeeded", phase: "Complete", progress: 100, message: "raw Git output", errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 2, cancelRequested: false };

it("uses diagnosed failures without inferring authentication from unrelated output", () => {
  const failed: TaskSnapshotResponse = { ...task, status: "failed", errorCategory: "commandFailed", failureCode: "LEASE_STALE", logs: ["remote: Authentication failed in the tests"] };
  expect(taskFailureHint(failed)).toContain("remote branch changed");
  expect(isAuthenticationFailure(failed)).toBe(false);
  expect(isAuthenticationFailure({ ...failed, failureCode: "AUTHENTICATION_FAILED", logs: [] })).toBe(true);
  expect(isAuthenticationFailure({ ...failed, failureCode: undefined })).toBe(true);
  expect(taskFailureHint({ ...failed, failureCode: undefined, errorCategory: "network" })).toBe("Network connection failed");
  setLocale("zh");
  expect(taskFailureHint({ ...failed, failureCode: "RESTORE_CONFLICT" })).toContain("恢复保存的修改时发生冲突");
});

it("groups newest tasks by repository without exposing repository identifiers", () => {
  const groups = groupTasksByRepository([task, { ...task, taskId: "new", createdAtMs: 3 }, { ...task, taskId: "clone", repoId: null, targetPath: "C:\\work\\other", createdAtMs: 2 }], [{ repoId: task.repoId, path: "C:/work/project" } as RepositoryResponse]);
  expect(groups.map((group) => group.name)).toEqual(["project", "other"]);
  expect(groups[0].tasks.map((entry) => entry.taskId)).toEqual(["new", "task"]);
  expect(groupTasksByRepository([task], [])[0].name).toBe("Repository");
});

it("translates dynamic operations, phases and outcomes without parsing diagnostics", () => {
  setLocale("zh");
  expect(taskOperationLabel("shelfApply:opaque-id:opaque-tree")).toBe("应用搁置");
  expect(taskOperationLabel("futureInternalOperation")).toBe("Git 操作");
  expect(taskOperationLabel("__proto__")).toBe("Git 操作");
  expect(taskPhaseLabel("Receiving objects")).toBe("正在接收对象");
  expect(taskPhaseLabel("futureInternalPhase")).toBe("正在处理");
  expect(taskPhaseLabel("constructor")).toBe("正在处理");
  expect(taskOutcome(task)).toBe("已获取远程引用。");
  expect(taskOutcome({ ...task, operation: "push", status: "failed" })).toContain("推送失败");
  expect(taskRelativeTime(60_000, 180_000)).toBe("2分钟前");
});
