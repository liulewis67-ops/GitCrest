// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../src/api/client";
import { useAdoptInProgressWorkflow } from "../../src/features/workflows/model/use-adopt-in-progress-workflow";

const task = { taskId: "task-adopted", operation: "merge", status: "waitingForInput" } as TaskSnapshotResponse;

it("asks the engine to adopt an in-progress operation when a repository is shown and when the window regains focus", async () => {
  const adoptRepositoryWorkflow = vi.fn().mockResolvedValueOnce({ adopted: true, task }).mockResolvedValue({ adopted: false, task: null });
  const api = { adoptRepositoryWorkflow } as unknown as GitCrestApiClient;
  const onAdopted = vi.fn();
  const { rerender } = renderHook(({ repoId }) => useAdoptInProgressWorkflow({ getApi: () => api, repoId, connected: true, onAdopted }), { initialProps: { repoId: undefined as string | undefined } });
  expect(adoptRepositoryWorkflow).not.toHaveBeenCalled();

  rerender({ repoId: "repo_a" });
  await waitFor(() => expect(onAdopted).toHaveBeenCalledWith(task));
  expect(adoptRepositoryWorkflow).toHaveBeenCalledWith("repo_a");

  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(adoptRepositoryWorkflow).toHaveBeenCalledTimes(2));
  expect(onAdopted).toHaveBeenCalledTimes(1);
});

it("does nothing while disconnected and swallows probe failures", async () => {
  const adoptRepositoryWorkflow = vi.fn().mockRejectedValue(new Error("offline"));
  const api = { adoptRepositoryWorkflow } as unknown as GitCrestApiClient;
  const onAdopted = vi.fn();
  renderHook(() => useAdoptInProgressWorkflow({ getApi: () => api, repoId: "repo_a", connected: false, onAdopted }));
  expect(adoptRepositoryWorkflow).not.toHaveBeenCalled();
  renderHook(() => useAdoptInProgressWorkflow({ getApi: () => api, repoId: "repo_a", connected: true, onAdopted }));
  await waitFor(() => expect(adoptRepositoryWorkflow).toHaveBeenCalled());
  expect(onAdopted).not.toHaveBeenCalled();
});
