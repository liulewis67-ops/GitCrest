// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TaskSnapshotResponse } from "../../src/api/client";
import { useAutoOpenConflicts } from "../../src/features/workflows/model/use-auto-open-conflicts";

const task = (status: TaskSnapshotResponse["status"], taskId = "t1"): TaskSnapshotResponse => ({
  taskId, repoId: "repo_x", operation: "merge", status, phase: "", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false, targetPath: null, resultRepoId: null,
} as TaskSnapshotResponse);

it("opens the conflict window once when a running workflow starts waiting for input", () => {
  const open = vi.fn();
  const isRecoverable = (operation: string) => operation === "merge";
  const { rerender } = renderHook(({ tasks }) => useAutoOpenConflicts({ tasks, isRecoverableOperation: isRecoverable, openConflictWindow: open }), { initialProps: { tasks: [task("running")] } });
  expect(open).not.toHaveBeenCalled();
  rerender({ tasks: [task("waitingForInput")] });
  expect(open).toHaveBeenCalledTimes(1);
  rerender({ tasks: [task("waitingForInput")] });
  expect(open).toHaveBeenCalledTimes(1);
});

it("does not reopen tasks that were already waiting when the app loaded", () => {
  const open = vi.fn();
  renderHook(() => useAutoOpenConflicts({ tasks: [task("waitingForInput")], isRecoverableOperation: () => true, openConflictWindow: open }));
  expect(open).not.toHaveBeenCalled();
});
