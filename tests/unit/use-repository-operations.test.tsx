// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, OperationRecoveryResponse } from "../../src/api/client";
import { useRepositoryOperations } from "../../src/features/operations/model/use-repository-operations";

afterEach(cleanup);

const op = (patch: Partial<OperationRecoveryResponse> = {}) => ({
  operationId: "op-1", version: "7", actionsEnabled: true, allowedActions: ["abortPullRebase"], ...patch,
}) as OperationRecoveryResponse;

function fakeApi(overrides: Record<string, unknown>) {
  const api: Record<string, unknown> = { withSignal: () => api, ...overrides };
  return api as unknown as GitCrestApiClient;
}

describe("useRepositoryOperations", () => {
  it("loads active operations and submits an allowed action then refreshes", async () => {
    const list = vi.fn().mockResolvedValueOnce([op()]).mockResolvedValueOnce([]);
    const submit = vi.fn().mockResolvedValue({ action: {}, task: null });
    const api = fakeApi({ listActiveRepositoryOperations: list, submitRepositoryOperationAction: submit });
    const { result } = renderHook(() => useRepositoryOperations(() => api, "repo-1"));
    await act(() => result.current.refresh());
    expect(result.current.operations).toHaveLength(1);
    await act(() => result.current.submitAction(result.current.operations[0], "abortPullRebase", "req-1"));
    expect(submit).toHaveBeenCalledWith("repo-1", "op-1", { requestId: "req-1", kind: "abortPullRebase", expectedVersion: "7" });
    await waitFor(() => expect(result.current.operations).toEqual([]));
  });
  it("reports an error without submitting a disallowed action", async () => {
    const submit = vi.fn();
    const api = fakeApi({ listActiveRepositoryOperations: vi.fn().mockResolvedValue([op()]), submitRepositoryOperationAction: submit });
    const { result } = renderHook(() => useRepositoryOperations(() => api, "repo-1"));
    await act(() => result.current.refresh());
    await act(() => result.current.submitAction(result.current.operations[0], "restoreNext", "req-2"));
    expect(submit).not.toHaveBeenCalled();
    expect(result.current.error).not.toBe("");
  });
});
