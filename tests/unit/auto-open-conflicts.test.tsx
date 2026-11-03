// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { TaskSnapshotResponse } from "../../src/api/client";
import { useAutoOpenConflicts } from "../../src/features/workflows/model/use-auto-open-conflicts";
import { supportsWorkflowRecovery } from "../../src/features/tasks/model/task-operations";

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

it("opens an unresolved task already waiting when the app loads, once", () => {
  const open = vi.fn();
  const { rerender } = renderHook(() => useAutoOpenConflicts({ tasks: [task("waitingForInput")], isRecoverableOperation: () => true, openConflictWindow: open }));
  expect(open).toHaveBeenCalledOnce();
  rerender();
  expect(open).toHaveBeenCalledOnce();
});

it("opens the resolver for a shelf restore conflict after switching branches or pulling", () => {
  const open = vi.fn();
  const shelf = { ...task("running"), operation: `shelfApply:saved-local-edits:${"a".repeat(40)}` };
  const { rerender } = renderHook(({ tasks }) => useAutoOpenConflicts({
    tasks, isRecoverableOperation: supportsWorkflowRecovery, openConflictWindow: open,
  }), { initialProps: { tasks: [shelf] } });
  const waiting = { ...shelf, status: "waitingForInput" as const };
  rerender({ tasks: [waiting] });
  expect(open).toHaveBeenCalledExactlyOnceWith(waiting);
  rerender({ tasks: [waiting] });
  expect(open).toHaveBeenCalledOnce();
});

it("opens every pending conflict without losing simultaneous waiting tasks", () => {
  const open = vi.fn();
  const first = { ...task("waitingForInput", "first"), operation: "resolveConflicts" };
  const second = task("waitingForInput", "second");
  const { rerender } = renderHook(({ tasks }) => useAutoOpenConflicts({ tasks, isRecoverableOperation: supportsWorkflowRecovery, openConflictWindow: open }), { initialProps: { tasks: [first, second] } });
  expect(open).toHaveBeenCalledTimes(2);
  rerender({ tasks: [] });
  rerender({ tasks: [first, second] });
  expect(open).toHaveBeenCalledTimes(2);
});
