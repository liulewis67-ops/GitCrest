// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BranchSwitchPreflightResponse, GitCrestApiClient, RepositoryResponse, TaskSnapshotResponse } from "../../src/api/client";
import { useBranchSwitcher } from "../../src/features/branches";
import { withPreservedChanges } from "../../src/features/shelves";

vi.mock("../../src/features/shelves", () => ({
  withPreservedChanges: vi.fn(async (_api, _repoId, run, onTask) => onTask(await run())),
}));

afterEach(cleanup);

const OID = "a".repeat(40);
const repository = { repoId: "repo_a", path: "/r", head: "b".repeat(40), branch: "main", detached: false, availability: "available" } as unknown as RepositoryResponse;
const preflight: BranchSwitchPreflightResponse = {
  repoId: "repo_a", current: "main", target: OID, localBranch: OID, createsLocalBranch: false, detached: true,
  isClean: true, dirtyFiles: [], potentiallyOverwrittenPaths: [],
};

function setup(overlap: string[] = []) {
  const api = {
    preflightRepositoryBranchSwitch: vi.fn().mockResolvedValue({ ...preflight, isClean: overlap.length === 0, potentiallyOverwrittenPaths: overlap }),
    switchRepositoryBranch: vi.fn().mockResolvedValue({ taskId: "t1" } as TaskSnapshotResponse),
  } as unknown as GitCrestApiClient;
  const onTaskAccepted = vi.fn();
  const hook = renderHook(() => useBranchSwitcher({
    getApi: () => api, getRepository: () => repository, refreshBranches: vi.fn(), onTaskAccepted, openTaskCenter: vi.fn(),
  }));
  return { api, onTaskAccepted, ...hook };
}

describe("commit checkout in the branch switcher", () => {
  it("reviews and starts a detached checkout, remembering the branch to return to", async () => {
    const { api, onTaskAccepted, result } = setup();
    act(() => result.current.checkoutCommit(OID));
    await waitFor(() => expect(result.current.preflight?.detached).toBe(true));
    expect(api.preflightRepositoryBranchSwitch).toHaveBeenCalledWith("repo_a", OID, false, true);
    expect(result.current.targetCommit).toBe(true);
    expect(result.current.returnBranches).toEqual({ repo_a: "main" });

    await act(() => result.current.continueSwitch());
    expect(api.switchRepositoryBranch).toHaveBeenCalledWith("repo_a", OID, false, true);
    expect(onTaskAccepted).toHaveBeenCalled();
  });

  it("preserves overlapping local edits and starts the checkout", async () => {
    const { api, result } = setup(["src/a.ts"]);
    act(() => result.current.checkoutCommit(OID));
    await waitFor(() => expect(result.current.preflight).toBeDefined());
    await act(() => result.current.continueSwitch());
    expect(withPreservedChanges).toHaveBeenCalledWith(api, "repo_a", expect.any(Function), expect.any(Function));
    expect(api.switchRepositoryBranch).toHaveBeenCalledWith("repo_a", OID, false, true);
  });
});
