// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BranchSwitchPreflightResponse, GitCrestApiClient, RepositoryResponse, TaskSnapshotResponse } from "../../src/api/client";
import { useBranchSwitcher } from "../../src/features/branches";
import { withPreservedChanges } from "../../src/features/shelves";
import { getBranchChangePolicy, setBranchChangePolicy, BRANCH_CHANGE_POLICY_KEY } from "../../src/shared/preferences/branch-change-policy";

vi.mock("../../src/features/shelves", () => ({
  withPreservedChanges: vi.fn(async (_api, _repoId, run, onTask) => onTask(await run())),
}));

afterEach(() => { cleanup(); localStorage.removeItem(BRANCH_CHANGE_POLICY_KEY); });

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
    getApi: () => api, getRepository: () => repository, refreshBranches: vi.fn(), onTaskAccepted,
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
    expect(withPreservedChanges).toHaveBeenLastCalledWith(api, "repo_a", expect.any(Function), expect.any(Function), { keepOnSourceBranch: false, saveBeforeOperation: false });
  });

  it("preserves overlapping local edits and starts the checkout", async () => {
    const { api, result } = setup(["src/a.ts"]);
    act(() => result.current.checkoutCommit(OID));
    await waitFor(() => expect(result.current.preflight).toBeDefined());
    await act(() => result.current.continueSwitch());
    expect(result.current.choosingChanges).toBe(true);
    expect(api.switchRepositoryBranch).not.toHaveBeenCalled();
    await act(() => result.current.continueSwitch("carry"));
    expect(withPreservedChanges).toHaveBeenCalledWith(api, "repo_a", expect.any(Function), expect.any(Function), { keepOnSourceBranch: false, saveBeforeOperation: true });
    expect(api.switchRepositoryBranch).toHaveBeenCalledWith("repo_a", OID, false, true);
  });

  it.each(["keep", "carry"] as const)("remembers always %s across future switchers", async (mode) => {
    const { result } = setup(["local.txt"]);
    await act(() => result.current.inspect("other"));
    await act(() => result.current.continueSwitch());
    await act(() => result.current.continueSwitch(mode, true));
    expect(getBranchChangePolicy()).toBe(mode);
    const second = setup(["local.txt"]);
    await act(() => second.result.current.inspect("another"));
    await act(() => second.result.current.continueSwitch());
    expect(second.result.current.choosingChanges).toBe(false);
    expect(withPreservedChanges).toHaveBeenLastCalledWith(second.api, "repo_a", expect.any(Function), expect.any(Function), { keepOnSourceBranch: mode === "keep", saveBeforeOperation: true });
  });

  it("asks again after a one-time choice and after settings reset the policy", async () => {
    const { result } = setup(["local.txt"]);
    await act(() => result.current.inspect("other"));
    await act(() => result.current.continueSwitch("keep"));
    expect(getBranchChangePolicy()).toBe("ask");
    await act(() => result.current.inspect("main"));
    await act(() => result.current.continueSwitch());
    expect(result.current.choosingChanges).toBe(true);
    act(() => setBranchChangePolicy("carry"));
    act(() => setBranchChangePolicy("ask"));
    await act(() => result.current.inspect("another"));
    await act(() => result.current.continueSwitch());
    expect(result.current.choosingChanges).toBe(true);
  });
});
