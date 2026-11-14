// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { useActiveOperationCount } from "../../src/features/operations";

afterEach(cleanup);

function fakeApi(list: ReturnType<typeof vi.fn>) {
  const api: Record<string, unknown> = { withSignal: () => api, listActiveRepositoryOperations: list };
  return api as unknown as GitCrestApiClient;
}

describe("useActiveOperationCount", () => {
  it("counts the repository's active operations and reads again on a token change and on window focus", async () => {
    const list = vi.fn().mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}, {}]).mockResolvedValue([]);
    const api = fakeApi(list);
    const { result, rerender } = renderHook(({ token }) => useActiveOperationCount(() => api, "repo", token), { initialProps: { token: "a" } });
    await waitFor(() => expect(result.current).toBe(1));
    rerender({ token: "b" });
    await waitFor(() => expect(result.current).toBe(2));
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(result.current).toBe(0));
    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenCalledWith("repo");
  });

  it("is zero without a repository and never contacts the core", () => {
    const list = vi.fn();
    const { result } = renderHook(() => useActiveOperationCount(() => fakeApi(list), undefined));
    expect(result.current).toBe(0);
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps the last count when a read fails, and resets it for another repository", async () => {
    const list = vi.fn().mockResolvedValueOnce([{}]).mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
    const api = fakeApi(list);
    const { result, rerender } = renderHook(({ repo }) => useActiveOperationCount(() => api, repo, ""), { initialProps: { repo: "repo-a" } });
    await waitFor(() => expect(result.current).toBe(1));
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current).toBe(1);
    rerender({ repo: "repo-b" });
    expect(result.current).toBe(0);
  });
});
