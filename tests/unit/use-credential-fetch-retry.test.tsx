// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../src/api/client";
import { useCredentialFetchRetry } from "../../src/features/tasks";
import { emitCredentialSaved } from "../../src/shared/lib/credential-events";

afterEach(cleanup);

const failedFetch = (taskId: string, repoId = "repo_a", operation = "fetch"): TaskSnapshotResponse => ({
  taskId, repoId, targetPath: null, resultRepoId: null, operation, status: "failed", phase: "Failed", progress: null,
  message: "Git command failed with exit code 128", errorCategory: "authentication", logs: [], createdAtMs: 1, updatedAtMs: 2, cancelRequested: false,
}) as TaskSnapshotResponse;

function setup(tasks: TaskSnapshotResponse[]) {
  const accepted = { taskId: "new-fetch" } as TaskSnapshotResponse;
  const fetchRepository = vi.fn().mockResolvedValue(accepted);
  const onTaskAccepted = vi.fn();
  const api = { fetchRepository } as unknown as GitCrestApiClient;
  renderHook(() => useCredentialFetchRetry({
    tasks,
    getApi: () => api,
    hostsForRepository: (repoId) => (repoId === "repo_a" ? ["git.example.test"] : ["other.example.test"]),
    onTaskAccepted,
  }));
  return { fetchRepository, onTaskAccepted, accepted };
}

describe("credential fetch retry", () => {
  it("starts one fetch per repository when a credential for its host is saved, and never retries the same task again", async () => {
    const { fetchRepository, onTaskAccepted, accepted } = setup([failedFetch("t1"), failedFetch("t2"), failedFetch("t3", "repo_b")]);
    emitCredentialSaved("git.example.test");
    expect(fetchRepository).toHaveBeenCalledTimes(1);
    expect(fetchRepository).toHaveBeenCalledWith("repo_a");
    await vi.waitFor(() => expect(onTaskAccepted).toHaveBeenCalledWith(accepted));
    emitCredentialSaved("git.example.test");
    expect(fetchRepository).toHaveBeenCalledTimes(1);
  });
  it("ignores a credential for another host and never retries a failed push", () => {
    const { fetchRepository } = setup([failedFetch("t1"), failedFetch("t2", "repo_a", "push")]);
    emitCredentialSaved("unrelated.example.test");
    expect(fetchRepository).not.toHaveBeenCalled();
  });
});
