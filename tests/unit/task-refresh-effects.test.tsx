// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, RepositoryResponse, TaskSnapshotResponse } from "../../src/api/client";
import { useTaskRefreshEffects } from "../../src/features/tasks/model/use-task-refresh-effects";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const terminalCommit: TaskSnapshotResponse = {
  taskId: "task-commit",
  repoId: "repo_a",
  targetPath: null,
  resultRepoId: null,
  operation: "commit",
  status: "succeeded",
  phase: "Complete",
  progress: 100,
  message: null,
  errorCategory: null,
  logs: [],
  createdAtMs: 1,
  updatedAtMs: 2,
  cancelRequested: false,
};

describe("task refresh effects", () => {
  it("aborts terminal-task repository metadata reads when the effect unmounts", async () => {
    const response = deferred<RepositoryResponse>();
    const signals: AbortSignal[] = [];
    let api: Record<string, unknown>;
    api = {
      withSignal: vi.fn((signal: AbortSignal) => {
        signals.push(signal);
        return api;
      }),
      getRepository: vi.fn(() => response.promise),
    };
    const updateRepository = vi.fn();
    const { unmount } = renderHook(() => useTaskRefreshEffects({
      tasks: [terminalCommit],
      getApi: () => api as unknown as GitCrestApiClient,
      refreshRepositoryStatus: vi.fn().mockResolvedValue(undefined),
      refreshRepositoryBranches: vi.fn().mockResolvedValue(undefined),
      refreshRepositoryRemotes: vi.fn().mockResolvedValue(undefined),
      refreshHistory: vi.fn(),
      updateRepository,
      reportError: vi.fn(),
    }));

    await waitFor(() => expect(signals).toHaveLength(1));
    unmount();
    expect(signals[0]?.aborted).toBe(true);
    response.resolve({} as RepositoryResponse);
    await response.promise;
    await Promise.resolve();
    expect(updateRepository).not.toHaveBeenCalled();
  });
});
