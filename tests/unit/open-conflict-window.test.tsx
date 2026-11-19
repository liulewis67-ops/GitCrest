// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GitCrestApiClient, GitCrestApiError, type TaskSnapshotResponse, type WorkflowRecoveryPreflightResponse } from "../../src/api/client";
import { useOpenConflictWindow } from "../../src/features/workflows/model/use-open-conflict-window";
import { useAutoOpenConflicts } from "../../src/features/workflows/model/use-auto-open-conflicts";

const bridge = vi.hoisted(() => ({ openConflictWindow: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/api/bridge", () => ({ requireGitCrestBridge: () => bridge }));
afterEach(() => vi.restoreAllMocks());

const task = { taskId: "old-task", repoId: "repo_x", operation: "merge", status: "waitingForInput" } as TaskSnapshotResponse;
const preview: WorkflowRecoveryPreflightResponse = {
  repoId: task.repoId!, taskId: task.taskId, operation: "merge", headOid: "abc",
  dirtyPaths: [], omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0,
  canContinue: true, canSkip: false, canAbort: true,
};

function setup() {
  bridge.openConflictWindow.mockClear();
  const api = new GitCrestApiClient("http://localhost", "token");
  const preflight = vi.spyOn(api, "preflightRepositoryWorkflowRecovery");
  const setTaskError = vi.fn();
  const options = { getApi: () => api, clearTaskError: vi.fn(), setTaskError };
  return { preflight, options, setTaskError };
}

it("does not reopen a persisted stale task at startup or after subsequent polling", async () => {
  const { preflight, options, setTaskError } = setup();
  preflight.mockRejectedValue(new GitCrestApiError(409, { error: { code: "WORKFLOW_NO_ACTIVE_OPERATION", message: "No active operation" } }));
  const { rerender } = renderHook(() => {
    const open = useOpenConflictWindow(options);
    useAutoOpenConflicts({ tasks: [task], isRecoverableOperation: () => true, openConflictWindow: (task) => open(task, true) });
  });
  await waitFor(() => expect(preflight).toHaveBeenCalledOnce());
  rerender();
  expect(preflight).toHaveBeenCalledOnce();
  expect(bridge.openConflictWindow).not.toHaveBeenCalled();
  expect(setTaskError).not.toHaveBeenCalled();
});

it("only automatically opens when the preflight confirms conflicts", async () => {
  const { preflight, options } = setup();
  const { result } = renderHook(() => useOpenConflictWindow(options));
  preflight.mockResolvedValue(preview);
  expect(await result.current(task, true)).toBe(true);
  expect(bridge.openConflictWindow).not.toHaveBeenCalled();
  preflight.mockResolvedValue({ ...preview, conflictedPaths: ["conflicted.txt"] });
  expect(await result.current(task, true)).toBe(true);
  expect(bridge.openConflictWindow).toHaveBeenCalledExactlyOnceWith({ repoId: task.repoId, taskId: task.taskId });
});

it("preserves manual recovery when the conflicts have already been resolved", async () => {
  const { preflight, options } = setup();
  const { result } = renderHook(() => useOpenConflictWindow(options));
  expect(await result.current(task)).toBe(true);
  expect(preflight).not.toHaveBeenCalled();
  expect(bridge.openConflictWindow).toHaveBeenCalledOnce();
});

it("reports transient preflight failures and permits retry instead of opening an empty window", async () => {
  const { preflight, options, setTaskError } = setup();
  const { result } = renderHook(() => useOpenConflictWindow(options));
  preflight.mockRejectedValue(new Error("Disconnected"));
  expect(await result.current(task, true)).toBe(false);
  expect(setTaskError).toHaveBeenCalledOnce();
  expect(bridge.openConflictWindow).not.toHaveBeenCalled();
});
