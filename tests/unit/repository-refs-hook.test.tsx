// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BranchSnapshotResponse, GitCrestApiClient, RemoteSnapshotResponse } from "../../src/api/client";
import { useRepositoryRefs } from "../../src/features/branches/model/use-repository-refs";

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

describe("repository refs request lifecycle", () => {
  it("aborts branch and remote reads when the repository cache is cleared", async () => {
    const branchesResponse = deferred<BranchSnapshotResponse>();
    const remotesResponse = deferred<RemoteSnapshotResponse>();
    const signals: AbortSignal[] = [];
    let api: Record<string, unknown>;
    api = {
      withSignal: vi.fn((signal: AbortSignal) => {
        signals.push(signal);
        return api;
      }),
      getRepositoryBranches: vi.fn(() => branchesResponse.promise),
      getRepositoryRemotes: vi.fn(() => remotesResponse.promise),
    };
    let isOpen = true;
    let generation = 0;
    const finishCacheRequest = vi.fn();
    const { result } = renderHook(() => useRepositoryRefs({
      getApi: () => api as unknown as GitCrestApiClient,
      isRepositoryOpen: () => isOpen,
      getCacheGeneration: () => generation,
      beginCacheRequest: () => generation,
      finishCacheRequest,
    }));
    let branchesRequest!: Promise<void>;
    let remotesRequest!: Promise<void>;

    act(() => {
      branchesRequest = result.current.refreshBranches("repo_a");
      remotesRequest = result.current.refreshRemotes("repo_a");
    });
    await waitFor(() => expect(signals).toHaveLength(2));
    isOpen = false;
    generation += 1;
    act(() => result.current.clear("repo_a"));
    expect(signals.every((signal) => signal.aborted)).toBe(true);

    branchesResponse.reject(new DOMException("The request was aborted.", "AbortError"));
    remotesResponse.reject(new DOMException("The request was aborted.", "AbortError"));
    await act(async () => Promise.all([branchesRequest, remotesRequest]));
    expect(result.current.branches).toEqual({});
    expect(result.current.remotes).toEqual({});
    expect(result.current.branchErrors).toEqual({});
    expect(result.current.remoteErrors).toEqual({});
    expect(finishCacheRequest).toHaveBeenCalledTimes(2);
  });
});
