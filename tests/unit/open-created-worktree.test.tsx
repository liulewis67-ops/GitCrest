// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../src/api/client";
import { useOpenCreatedWorktree } from "../../src/features/branches/model/use-open-created-worktree";

const task = (status: TaskSnapshotResponse["status"], resultRepoId: string | null, operation = "worktreeCreate", taskId = "t1") =>
  ({ taskId, operation, status, resultRepoId } as TaskSnapshotResponse);

it("opens a worktree once its creation task succeeds, but only if it was seen running in this window", async () => {
  const getRepository = vi.fn().mockResolvedValue({ repoId: "repo_new", path: "D:/trees/app-feature" });
  const api = { getRepository } as unknown as GitCrestApiClient;
  const openPath = vi.fn().mockResolvedValue(undefined);
  const onOpened = vi.fn();
  const { rerender } = renderHook(({ tasks }) => useOpenCreatedWorktree({ tasks, getApi: () => api, openPath, onOpened }), {
    initialProps: { tasks: [task("succeeded", "repo_old", "worktreeCreate", "old")] },
  });
  expect(getRepository).not.toHaveBeenCalled();

  rerender({ tasks: [task("queued", null), task("succeeded", "repo_old", "worktreeCreate", "old")] });
  expect(getRepository).not.toHaveBeenCalled();
  rerender({ tasks: [task("succeeded", "repo_new"), task("succeeded", "repo_old", "worktreeCreate", "old")] });
  await waitFor(() => expect(openPath).toHaveBeenCalledWith("D:/trees/app-feature"));
  expect(getRepository).toHaveBeenCalledTimes(1);
  expect(getRepository).toHaveBeenCalledWith("repo_new");
  expect(onOpened).toHaveBeenCalledTimes(1);

  rerender({ tasks: [task("succeeded", "repo_new")] });
  expect(getRepository).toHaveBeenCalledTimes(1);
});

it("ignores other operations and failed worktree tasks", () => {
  const getRepository = vi.fn();
  const api = { getRepository } as unknown as GitCrestApiClient;
  const { rerender } = renderHook(({ tasks }) => useOpenCreatedWorktree({ tasks, getApi: () => api, openPath: vi.fn(), onOpened: vi.fn() }), {
    initialProps: { tasks: [task("running", null, "branchCreate", "a"), task("running", null, "worktreeCreate", "b")] },
  });
  rerender({ tasks: [task("succeeded", "repo_x", "branchCreate", "a"), task("failed", null, "worktreeCreate", "b")] });
  expect(getRepository).not.toHaveBeenCalled();
});
