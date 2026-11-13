import { describe, expect, it, vi } from "vitest";
import { GitCrestApiError, type GitCrestApiClient } from "../../src/api/client";
import { startOperation } from "../../src/features/operations/model/start-operation";

const input = { command: { kind: "pullMerge" as const }, preservation: "restore" as const };

describe("startOperation", () => {
  it("passes the previewed request unchanged to creation with the idempotency id", async () => {
    const request = { changesFingerprint: "f" };
    const created = { operationId: "op", dispatched: true, action: null, task: null };
    const api = {
      previewRepositoryOperation: vi.fn().mockResolvedValue(request),
      createRepositoryOperation: vi.fn().mockResolvedValue(created),
    } as unknown as GitCrestApiClient;
    await expect(startOperation(api, "repo", input, "req-1")).resolves.toEqual({ kind: "started", created });
    expect(api.createRepositoryOperation).toHaveBeenCalledWith("repo", { requestId: "req-1", request });
  });
  it("reports a rollout-disabled server without creating and rethrows other failures", async () => {
    const disabled = new GitCrestApiError(403, { error: { code: "OPERATION_CREATION_DISABLED", message: "off" } } as never);
    const create = vi.fn();
    const off = { previewRepositoryOperation: vi.fn().mockRejectedValue(disabled), createRepositoryOperation: create } as unknown as GitCrestApiClient;
    await expect(startOperation(off, "repo", input, "r")).resolves.toEqual({ kind: "disabled" });
    expect(create).not.toHaveBeenCalled();
    const stale = new GitCrestApiError(409, { error: { code: "WORKFLOW_PREFLIGHT_STALE", message: "stale" } } as never);
    const bad = { previewRepositoryOperation: vi.fn().mockRejectedValue(stale), createRepositoryOperation: create } as unknown as GitCrestApiClient;
    await expect(startOperation(bad, "repo", input, "r")).rejects.toBe(stale);
  });
});
