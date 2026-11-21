// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BranchSwitchPreflightResponse, GitCrestApiClient, RepositoryResponse } from "../../src/api/client";
import { useBranchSwitcher } from "../../src/features/branches/model/use-branch-switcher";
import { useRepositoryPull } from "../../src/features/remotes/model/use-repository-pull";
import { useRepositoryPush } from "../../src/features/remotes/model/use-repository-push";
import { BRANCH_CHANGE_POLICY_KEY } from "../../src/shared/preferences/branch-change-policy";

vi.mock("../../src/features/shelves", () => ({ withPreservedChanges: vi.fn(async (_api, _repo, run, onTask) => onTask(await run())) }));
afterEach(() => { cleanup(); localStorage.removeItem(BRANCH_CHANGE_POLICY_KEY); });

const repo = { repoId: "repo", branch: "main", availability: "available" } as RepositoryResponse;
const branchPreview: BranchSwitchPreflightResponse = { repoId: "repo", current: "main", target: "feature", localBranch: "feature", createsLocalBranch: false, detached: false, isClean: true, dirtyFiles: [], potentiallyOverwrittenPaths: [] };
const pullPreview = { repoId: "repo", localBranch: "main", remoteName: "origin", remoteBranch: "main", localOid: "a".repeat(40), trackingOid: "b".repeat(40), ahead: 0, behind: 2, isClean: true, mergeRequiresPreservation: false, dirtyPaths: [], omittedDirtyPathCount: 0, hasConflicts: false, operationInProgress: false };
const pushPreview = { repoId: "repo", localBranch: "main", remoteName: "origin", remoteBranch: "main", localOid: "a".repeat(40), expectedRemoteOid: "b".repeat(40), ahead: 2, behind: 0, overwrittenCommitCount: 0, changedPaths: [], changedPathCount: 0, omittedChangedPathCount: 0, commitsToPush: [] };

function branch(preview = branchPreview) {
  const api = { preflightRepositoryBranchSwitch: vi.fn().mockResolvedValue(preview), switchRepositoryBranch: vi.fn().mockResolvedValue({ taskId: "switch", status: "succeeded" }) };
  const onTaskAccepted = vi.fn();
  const hook = renderHook(() => useBranchSwitcher({ getApi: () => api as unknown as GitCrestApiClient, getRepository: () => repo, refreshBranches: vi.fn(), onTaskAccepted }));
  return { api, onTaskAccepted, ...hook };
}

it("switches a clean branch immediately after selection with no confirmation", async () => {
  const { api, onTaskAccepted, result } = branch();
  act(() => result.current.openSwitcher());
  await act(() => result.current.inspect("feature"));
  expect(api.switchRepositoryBranch).toHaveBeenCalledExactlyOnceWith("repo", "feature", false, false);
  expect(onTaskAccepted).toHaveBeenCalledOnce();
  expect(result.current.open).toBe(false);
});

it("keeps non-overlapping local edits and switches without a decision dialog", async () => {
  const { api, result } = branch({ ...branchPreview, isClean: false, dirtyFiles: ["draft.txt"] });
  await act(() => result.current.inspect("feature"));
  expect(api.switchRepositoryBranch).toHaveBeenCalledOnce();
  expect(result.current.choosingChanges).toBe(false);
});

it("shows the local-change decision directly when a switch could overwrite edits", async () => {
  const { api, result } = branch({ ...branchPreview, isClean: false, dirtyFiles: ["draft.txt"], potentiallyOverwrittenPaths: ["draft.txt"] });
  await act(() => result.current.inspect("feature"));
  expect(api.switchRepositoryBranch).not.toHaveBeenCalled();
  expect(result.current.open).toBe(true);
  expect(result.current.choosingChanges).toBe(true);
  await act(() => result.current.continueSwitch("carry"));
  expect(api.switchRepositoryBranch).toHaveBeenCalledOnce();
});

function pull(preview = pullPreview) {
  const api = { preflightRepositoryPull: vi.fn().mockResolvedValue(preview), pullRepository: vi.fn().mockResolvedValue({ taskId: "pull", status: "succeeded" }) };
  const hook = renderHook(() => useRepositoryPull({ getApi: () => api as unknown as GitCrestApiClient, repoId: "repo", onSelectRepository: vi.fn(), onTaskAccepted: vi.fn(), refreshRepositoryStatus: vi.fn() }));
  return { api, ...hook };
}

it("pulls a clean fast-forward directly, but asks for a strategy after divergence", async () => {
  const smooth = pull();
  await act(() => smooth.result.current.openDialog());
  expect(smooth.api.pullRepository).toHaveBeenCalledExactlyOnceWith("repo", { expectedLocalOid: pullPreview.localOid, expectedTrackingOid: pullPreview.trackingOid, strategy: "merge" });
  expect(smooth.result.current.open).toBe(false);
  const diverged = pull({ ...pullPreview, ahead: 1 });
  await act(() => diverged.result.current.openDialog());
  expect(diverged.api.pullRepository).not.toHaveBeenCalled();
  expect(diverged.result.current.open).toBe(true);
});

it("stops a pull for conflicts or local preservation instead of starting it silently", async () => {
  for (const preview of [{ ...pullPreview, hasConflicts: true }, { ...pullPreview, isClean: false, mergeRequiresPreservation: true }]) {
    const current = pull(preview);
    await act(() => current.result.current.openDialog());
    expect(current.api.pullRepository).not.toHaveBeenCalled();
    expect(current.result.current.open).toBe(true);
    current.unmount();
  }
});

function push(preview = pushPreview) {
  const api = { preflightRepositoryPush: vi.fn().mockResolvedValue(preview), pushRepository: vi.fn().mockResolvedValue({ taskId: "push", status: "succeeded" }) };
  const hook = renderHook(() => useRepositoryPush({ tasks: [], getApi: () => api as unknown as GitCrestApiClient, repoId: "repo", onSelectRepository: vi.fn(), onTaskAccepted: vi.fn() }));
  return { api, ...hook };
}

it("pushes normally without a confirmation and keeps force pushes explicit", async () => {
  const smooth = push();
  await act(() => smooth.result.current.openDialog());
  expect(smooth.api.pushRepository).toHaveBeenCalledExactlyOnceWith("repo", { expectedLocalOid: pushPreview.localOid, expectedRemoteOid: pushPreview.expectedRemoteOid, forceWithLease: false, remoteName: "origin", remoteBranch: "main", tags: "none" });
  expect(smooth.result.current.open).toBe(false);
  const force = push({ ...pushPreview, behind: 2, overwrittenCommitCount: 2 });
  await act(() => force.result.current.openDialog("repo", undefined, true));
  expect(force.api.pushRepository).not.toHaveBeenCalled();
  expect(force.result.current.open).toBe(true);
});

it("coalesces rapid branch clicks and surfaces a failed automatic switch", async () => {
  const current = branch();
  let resolve!: (value: BranchSwitchPreflightResponse) => void;
  current.api.preflightRepositoryBranchSwitch.mockImplementation(() => new Promise((done) => { resolve = done; }));
  let first!: Promise<void>;
  act(() => { first = current.result.current.inspect("feature"); void current.result.current.inspect("feature"); });
  expect(current.api.preflightRepositoryBranchSwitch).toHaveBeenCalledOnce();
  current.api.switchRepositoryBranch.mockRejectedValueOnce(new Error("Branch changed during preflight"));
  await act(async () => { resolve(branchPreview); await first; });
  expect(current.api.switchRepositoryBranch).toHaveBeenCalledOnce();
  expect(current.result.current.open).toBe(true);
  expect(current.result.current.error).toBeTruthy();
});

it("reviews a failed push without automatically retrying it", async () => {
  const current = push();
  await act(async () => { current.result.current.reviewTask({ taskId: "failed", operation: "push", status: "failed", repoId: "repo" } as never); });
  expect(current.api.pushRepository).not.toHaveBeenCalled();
  expect(current.result.current.open).toBe(true);
});

it("shows errors after a refused push or pull instead of retrying automatically", async () => {
  const pushing = push();
  pushing.api.pushRepository.mockRejectedValueOnce(new Error("Push preview changed"));
  await act(() => pushing.result.current.openDialog());
  expect(pushing.result.current.open).toBe(true);
  expect(pushing.api.pushRepository).toHaveBeenCalledOnce();
  const pulling = pull();
  pulling.api.pullRepository.mockRejectedValueOnce(new Error("Pull preview changed"));
  await act(() => pulling.result.current.openDialog());
  expect(pulling.result.current.open).toBe(true);
  expect(pulling.api.pullRepository).toHaveBeenCalledOnce();
});

it("retains explicit push and pull options without submitting their default actions", async () => {
  const pushing = push();
  await act(() => pushing.result.current.openDialog(undefined, undefined, false, true));
  expect(pushing.result.current.open).toBe(true);
  expect(pushing.api.pushRepository).not.toHaveBeenCalled();
  const pulling = pull();
  await act(() => pulling.result.current.openDialog(undefined, true));
  expect(pulling.result.current.open).toBe(true);
  expect(pulling.api.pullRepository).not.toHaveBeenCalled();
});
