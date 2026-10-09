// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../src/api/client";
import { useTaskCenter } from "../../src/features/tasks/model/use-task-center";

afterEach(cleanup);

function deferred<T>() {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function task(taskId: string): TaskSnapshotResponse {
  return {
    taskId,
    repoId: "repo_a",
    targetPath: null,
    resultRepoId: null,
    operation: "fetch",
    status: "succeeded",
    phase: "Complete",
    progress: 100,
    message: null,
    errorCategory: null,
    logs: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    cancelRequested: false,
  };
}

function createApi(responses: Array<ReturnType<typeof deferred<TaskSnapshotResponse[]>>>) {
  const signals: AbortSignal[] = [];
  let api: Record<string, unknown>;
  api = {
    withSignal: vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return api;
    }),
    listTasks: vi.fn(() => responses.shift()!.promise),
  };
  return { api: api as unknown as GitCrestApiClient, signals };
}

describe("task center query lifecycle", () => {
  it("aborts older refreshes and applies only the latest task snapshot", async () => {
    const firstResponse = deferred<TaskSnapshotResponse[]>();
    const secondResponse = deferred<TaskSnapshotResponse[]>();
    const { api, signals } = createApi([firstResponse, secondResponse]);
    const { result } = renderHook(() => useTaskCenter(() => api));
    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;

    act(() => { firstRequest = result.current.refresh(); });
    await waitFor(() => expect(signals).toHaveLength(1));
    act(() => { secondRequest = result.current.refresh(); });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);

    secondResponse.resolve([task("newer")]);
    await act(async () => secondRequest);
    firstResponse.resolve([task("older")]);
    await act(async () => firstRequest);
    expect(result.current.tasks.map(({ taskId }) => taskId)).toEqual(["newer"]);
    expect(result.current.error).toBe("");
  });

  it("aborts a pending task refresh when the model unmounts", async () => {
    const response = deferred<TaskSnapshotResponse[]>();
    const { api, signals } = createApi([response]);
    const { result, unmount } = renderHook(() => useTaskCenter(() => api));
    let request!: Promise<void>;

    act(() => { request = result.current.refresh(); });
    await waitFor(() => expect(signals).toHaveLength(1));
    unmount();
    expect(signals[0]?.aborted).toBe(true);
    response.resolve([task("late")]);
    await act(async () => request);
  });
});
