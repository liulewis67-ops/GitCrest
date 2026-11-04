// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import type { GitCrestApiClient } from "../../src/api/client";
import { useRepositoryPull } from "../../src/features/remotes/model/use-repository-pull";
import { withPreservedChanges } from "../../src/features/shelves";

vi.mock("../../src/features/shelves", () => ({ withPreservedChanges: vi.fn(async (_api, _repo, run) => { await run(); }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const preview: components["schemas"]["PullPreflight"] = {
  repoId: "repo", localBranch: "main", remoteName: "origin", remoteBranch: "main",
  localOid: "a".repeat(40), trackingOid: "b".repeat(40), ahead: 0, behind: 1,
  isClean: false, mergeRequiresPreservation: false, dirtyPaths: ["draft.txt"],
  omittedDirtyPathCount: 0, hasConflicts: false, operationInProgress: false,
};

it.each([
  ["merge", false, false, false],
  ["merge", true, false, true],
  ["rebase", false, false, true],
  ["rebase", false, true, false],
] as const)("pull %s preserves only when needed (merge protection %s, clean %s)", async (strategy, mergeRequiresPreservation, isClean, expected) => {
  const api = {
    preflightRepositoryPull: vi.fn().mockResolvedValue({ ...preview, mergeRequiresPreservation, isClean }),
    pullRepository: vi.fn().mockResolvedValue({ taskId: "pull", status: "succeeded" }),
  };
  const hook = renderHook(() => useRepositoryPull({ getApi: () => api as unknown as GitCrestApiClient, repoId: "repo", onSelectRepository: vi.fn(), onTaskAccepted: vi.fn(), refreshRepositoryStatus: vi.fn() }));
  await act(() => hook.result.current.refreshPreflight());
  await act(() => hook.result.current.submit(strategy));
  expect(withPreservedChanges).toHaveBeenCalledWith(api, "repo", expect.any(Function), expect.any(Function), { saveBeforeOperation: expected });
  expect(api.pullRepository).toHaveBeenCalledOnce();
});

it("refreshes a changed upstream for review instead of starting from stale OIDs", async () => {
  const api = {
    preflightRepositoryPull: vi.fn().mockResolvedValueOnce(preview).mockResolvedValue({ ...preview, trackingOid: "c".repeat(40) }),
    pullRepository: vi.fn(),
  };
  const hook = renderHook(() => useRepositoryPull({ getApi: () => api as unknown as GitCrestApiClient, repoId: "repo", onSelectRepository: vi.fn(), onTaskAccepted: vi.fn(), refreshRepositoryStatus: vi.fn() }));
  await act(() => hook.result.current.refreshPreflight());
  await act(() => hook.result.current.submit("merge"));
  expect(withPreservedChanges).not.toHaveBeenCalled();
  expect(api.pullRepository).not.toHaveBeenCalled();
  expect(hook.result.current.preflight?.trackingOid).toBe("c".repeat(40));
});
