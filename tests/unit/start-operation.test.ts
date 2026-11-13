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

describe("startOperation against a core without operations", () => {
  it("falls back when the preview route does not exist, but not when creation itself is missing afterwards", async () => {
    for (const status of [404, 405]) {
      const missing = new GitCrestApiError(status, { error: { code: "NOT_FOUND", message: "no such route" } } as never);
      const create = vi.fn();
      const api = { previewRepositoryOperation: vi.fn().mockRejectedValue(missing), createRepositoryOperation: create } as unknown as GitCrestApiClient;
      await expect(startOperation(api, "repo", input, "r")).resolves.toEqual({ kind: "disabled" });
      expect(create).not.toHaveBeenCalled();
    }
    // A 404 from creation (after a successful preview) is a real failure, not "unsupported".
    const gone = new GitCrestApiError(404, { error: { code: "REPOSITORY_NOT_FOUND", message: "gone" } } as never);
    const api = { previewRepositoryOperation: vi.fn().mockResolvedValue({}), createRepositoryOperation: vi.fn().mockRejectedValue(gone) } as unknown as GitCrestApiClient;
    await expect(startOperation(api, "repo", input, "r")).rejects.toBe(gone);
  });
});
