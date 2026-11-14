// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { GitCrestApiError, type GitCrestApiClient } from "../../src/api/client";
import { useRepositoryPull } from "../../src/features/remotes/model/use-repository-pull";
import { OPERATION_FLOW_KEY } from "../../src/shared/preferences/operation-flow";

vi.mock("../../src/features/shelves", () => ({ withPreservedChanges: vi.fn(async (_api, _repo, run) => { await run(); }) }));
afterEach(() => { cleanup(); localStorage.removeItem(OPERATION_FLOW_KEY); vi.clearAllMocks(); });

const preview: components["schemas"]["PullPreflight"] = {
  repoId: "repo", localBranch: "main", remoteName: "origin", remoteBranch: "main",
  localOid: "a".repeat(40), trackingOid: "b".repeat(40), ahead: 1, behind: 1,
  isClean: true, mergeRequiresPreservation: false, dirtyPaths: [],
  omittedDirtyPathCount: 0, hasConflicts: false, operationInProgress: false,
};

function setup(overrides: Record<string, unknown> = {}) {
  const api = {
    preflightRepositoryPull: vi.fn().mockResolvedValue(preview),
    pullRepository: vi.fn().mockResolvedValue({ taskId: "legacy-pull" }),
    previewRepositoryOperation: vi.fn().mockResolvedValue({ changesFingerprint: "f" }),
    createRepositoryOperation: vi.fn().mockResolvedValue({ operationId: "op", dispatched: true, action: null, task: { taskId: "op-task" } }),
    ...overrides,
  };
  const onTaskAccepted = vi.fn();
  const onOperationStarted = vi.fn();
  const hook = renderHook(() => useRepositoryPull({ getApi: () => api as unknown as GitCrestApiClient, repoId: "repo", onSelectRepository: vi.fn(), onTaskAccepted, onOperationStarted, refreshRepositoryStatus: vi.fn() }));
  return { api, onTaskAccepted, onOperationStarted, hook };
}

describe("pull through a durable operation", () => {
  it("is off by default and never contacts the operations API", async () => {
    const { api, onOperationStarted, hook } = setup();
    await act(() => hook.result.current.refreshPreflight());
    await act(() => hook.result.current.submit("merge"));
    expect(api.previewRepositoryOperation).not.toHaveBeenCalled();
    expect(api.pullRepository).toHaveBeenCalledOnce();
    expect(onOperationStarted).not.toHaveBeenCalled();
  });

  it.each([["merge", "pullMerge"], ["rebase", "pullRebase"]] as const)("starts a %s pull as %s when opted in", async (strategy, kind) => {
    localStorage.setItem(OPERATION_FLOW_KEY, "on");
    const { api, onTaskAccepted, onOperationStarted, hook } = setup();
    await act(() => hook.result.current.refreshPreflight());
    await act(() => hook.result.current.submit(strategy));
    expect(api.previewRepositoryOperation).toHaveBeenCalledWith("repo", { command: { kind }, preservation: "restore" });
    expect(onTaskAccepted).toHaveBeenCalledWith({ taskId: "op-task" });
    expect(onOperationStarted).toHaveBeenCalledTimes(1);
    expect(api.pullRepository).not.toHaveBeenCalled();
  });

  it.each([
    ["the rollout flag is off", new GitCrestApiError(403, { error: { code: "OPERATION_CREATION_DISABLED", message: "off" } } as never)],
    ["the core has no operation routes", new GitCrestApiError(404, { error: { code: "NOT_FOUND", message: "no route" } } as never)],
  ])("falls back to the existing pull when %s", async (_label, failure) => {
    localStorage.setItem(OPERATION_FLOW_KEY, "on");
    const { api, onOperationStarted, hook } = setup({ previewRepositoryOperation: vi.fn().mockRejectedValue(failure) });
    await act(() => hook.result.current.refreshPreflight());
    await act(() => hook.result.current.submit("rebase"));
    expect(api.pullRepository).toHaveBeenCalledOnce();
    expect(onOperationStarted).not.toHaveBeenCalled();
    expect(api.createRepositoryOperation).not.toHaveBeenCalled();
  });
});
