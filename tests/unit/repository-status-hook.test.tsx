// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, StatusSnapshotResponse } from "../../src/api/client";
import { useRepositoryStatus } from "../../src/features/changes/model/use-repository-status";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createApi() {
  const firstResponse = deferred<StatusSnapshotResponse>();
  const secondResponse = deferred<StatusSnapshotResponse>();
  const responses = [firstResponse, secondResponse];
  const signals: AbortSignal[] = [];
  let api: Record<string, unknown>;
  api = {
    withSignal: vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return api;
    }),
    getRepositoryStatus: vi.fn(() => responses.shift()!.promise),
    getRepositoryStatusPaths: vi.fn(() => responses.shift()!.promise),
  };
  return { api: api as unknown as GitCrestApiClient, firstResponse, secondResponse, signals };
}

function status(repoId: string): StatusSnapshotResponse {
  return { repoId, refreshedAtMs: 1, files: [] };
}

describe("repository status request lifecycle", () => {
  it("aborts active refreshes when the cache clears and the model unmounts", async () => {
    const { api, firstResponse, secondResponse, signals } = createApi();
    let isOpen = true;
    let generation = 0;
    const finishCacheRequest = vi.fn();
    const { result, unmount } = renderHook(() => useRepositoryStatus({
      getApi: () => api,
      isRepositoryOpen: () => isOpen,
      getCacheGeneration: () => generation,
      beginCacheRequest: () => generation,
      finishCacheRequest,
    }));

    let firstRequest!: Promise<void>;
    act(() => { firstRequest = result.current.refreshScope("repo_a", true); });
    await waitFor(() => expect(signals).toHaveLength(1));
    isOpen = false;
    generation += 1;
    act(() => result.current.clear("repo_a"));
    expect(signals[0]?.aborted).toBe(true);

    firstResponse.resolve(status("repo_a"));
    await act(async () => firstRequest);
    expect(finishCacheRequest).toHaveBeenCalledOnce();
    expect(result.current.snapshots).toEqual({});
    expect(result.current.errors).toEqual({});

    isOpen = true;
    generation += 1;
    let secondRequest!: Promise<void>;
    act(() => { secondRequest = result.current.refreshScope("repo_a", true); });
    await waitFor(() => expect(signals).toHaveLength(2));
    unmount();
    expect(signals[1]?.aborted).toBe(true);
    secondResponse.resolve(status("repo_a"));
    await secondRequest;
  });
});
