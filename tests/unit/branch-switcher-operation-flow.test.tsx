// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCrestApiError, type BranchSwitchPreflightResponse, type GitCrestApiClient, type RepositoryResponse, type TaskSnapshotResponse } from "../../src/api/client";
import { useBranchSwitcher } from "../../src/features/branches";
import { OPERATION_FLOW_KEY } from "../../src/shared/preferences/operation-flow";

vi.mock("../../src/features/shelves", () => ({
  withPreservedChanges: vi.fn(async (_api, _repoId, run, onTask) => onTask(await run())),
}));

afterEach(() => { cleanup(); localStorage.removeItem(OPERATION_FLOW_KEY); });

const OID = "a".repeat(40);
const repository = { repoId: "repo_a", path: "/r", head: "b".repeat(40), branch: "main", detached: false, availability: "available" } as unknown as RepositoryResponse;
const preflight = {
  repoId: "repo_a", current: "main", target: OID, localBranch: OID, createsLocalBranch: false, detached: false,
  isClean: false, dirtyFiles: [], potentiallyOverwrittenPaths: ["src/a.ts"],
} as unknown as BranchSwitchPreflightResponse;

function setup(preview: ReturnType<typeof vi.fn>) {
  const api = {
    preflightRepositoryBranchSwitch: vi.fn().mockResolvedValue(preflight),
    switchRepositoryBranch: vi.fn().mockResolvedValue({ taskId: "legacy" } as TaskSnapshotResponse),
    previewRepositoryOperation: preview,
    createRepositoryOperation: vi.fn().mockResolvedValue({ operationId: "op", dispatched: true, action: null, task: { taskId: "op-task" } }),
  } as unknown as GitCrestApiClient;
  const onTaskAccepted = vi.fn();
  const onOperationStarted = vi.fn();
  const hook = renderHook(() => useBranchSwitcher({ getApi: () => api, getRepository: () => repository, refreshBranches: vi.fn(), onTaskAccepted, onOperationStarted }));
  return { api, onTaskAccepted, onOperationStarted, ...hook };
}

describe("operation flow for preserved branch switches", () => {
  it("is off by default and never contacts the operations API", async () => {
    const preview = vi.fn();
    const { api, onOperationStarted, result } = setup(preview);
    await act(() => result.current.inspect("feature"));
    await waitFor(() => expect(result.current.preflight).toBeDefined());
    await act(() => result.current.continueSwitch("carry"));
    expect(preview).not.toHaveBeenCalled();
    expect(api.switchRepositoryBranch).toHaveBeenCalled();
    expect(onOperationStarted).not.toHaveBeenCalled();
  });
  it("routes a preserved local switch through the operation when opted in", async () => {
    localStorage.setItem(OPERATION_FLOW_KEY, "on");
    const preview = vi.fn().mockResolvedValue({ changesFingerprint: "f" });
    const { api, onTaskAccepted, onOperationStarted, result } = setup(preview);
    await act(() => result.current.inspect("feature"));
    await waitFor(() => expect(result.current.preflight).toBeDefined());
    await act(() => result.current.continueSwitch("keep"));
    expect(preview).toHaveBeenCalledWith("repo_a", { command: { kind: "checkoutBranch", name: "feature" }, preservation: "keepOnSourceBranch" });
    expect(onTaskAccepted).toHaveBeenCalledWith({ taskId: "op-task" });
    // The user is taken to the Task Center, where the operation's next choice appears.
    expect(onOperationStarted).toHaveBeenCalledTimes(1);
    expect(api.switchRepositoryBranch).not.toHaveBeenCalled();
  });
  it("routes a preserved commit checkout as a detached checkout, but leaves remote branches to the existing flow", async () => {
    localStorage.setItem(OPERATION_FLOW_KEY, "on");
    const oid = "c".repeat(40);
    const preview = vi.fn().mockResolvedValue({ changesFingerprint: "f" });
    const commit = setup(preview);
    await act(() => commit.result.current.inspect(oid, false, true));
    await waitFor(() => expect(commit.result.current.preflight).toBeDefined());
    await act(() => commit.result.current.continueSwitch("keep"));
    expect(preview).toHaveBeenCalledWith("repo_a", { command: { kind: "checkoutDetached", targetOid: oid }, preservation: "keepOnSourceBranch" });
    expect(commit.api.switchRepositoryBranch).not.toHaveBeenCalled();

    const remotePreview = vi.fn();
    const remote = setup(remotePreview);
    await act(() => remote.result.current.inspect("origin/feature", true));
    await waitFor(() => expect(remote.result.current.preflight).toBeDefined());
    await act(() => remote.result.current.continueSwitch("keep"));
    expect(remotePreview).not.toHaveBeenCalled();
    expect(remote.api.switchRepositoryBranch).toHaveBeenCalled();
  });
  it("falls back to the existing flow when creation is disabled on the server", async () => {
    localStorage.setItem(OPERATION_FLOW_KEY, "on");
    const disabled = new GitCrestApiError(403, { error: { code: "OPERATION_CREATION_DISABLED", message: "off" } } as never);
    const { api, result } = setup(vi.fn().mockRejectedValue(disabled));
    await act(() => result.current.inspect("feature"));
    await waitFor(() => expect(result.current.preflight).toBeDefined());
    await act(() => result.current.continueSwitch("carry"));
    expect(api.switchRepositoryBranch).toHaveBeenCalled();
  });
});
