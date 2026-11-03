// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../src/api/client";
import { BatchRefDialog } from "../../src/features/branches/ui/BatchRefDialog";

afterEach(cleanup);
function task(id: string, status: TaskSnapshotResponse["status"], message: string | null = null): TaskSnapshotResponse {
  return { taskId: id, repoId: "repo", targetPath: null, resultRepoId: null, operation: "push", status, phase: "test", progress: null, message, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
}

it("requires review, preserves per-item failures and continues with remaining eligible targets", async () => {
  const first = vi.fn().mockResolvedValue(task("first", "queued"));
  const second = vi.fn().mockResolvedValue(task("second", "succeeded"));
  const blocked = vi.fn();
  const onChanged = vi.fn();
  const listTasks = vi.fn().mockResolvedValue([task("first", "failed", "Rejected: branch has diverged")]);
  render(<BatchRefDialog api={{ listTasks } as unknown as GitCrestApiClient} operation="push" targets={[
    { id: "a", name: "alpha", submit: first }, { id: "b", name: "beta", submit: second }, { id: "c", name: "main", blocked: "Protected branch", submit: blocked },
  ]} onClose={vi.fn()} onChanged={onChanged} />);
  expect(first).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm and run" }));
  expect(second).not.toHaveBeenCalled();
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(screen.getByText("Rejected: branch has diverged")).toBeDefined();
  expect(second).toHaveBeenCalledOnce();
  expect(blocked).not.toHaveBeenCalled();
  expect(screen.getByText("Succeeded")).toBeDefined();
});

it("cancels the active task and skips unsent targets when stopped", async () => {
  const first = vi.fn().mockResolvedValue(task("first", "running"));
  const next = vi.fn();
  const cancelTask = vi.fn().mockResolvedValue(task("first", "cancelled"));
  const listTasks = vi.fn().mockResolvedValue([task("first", "cancelled")]);
  render(<BatchRefDialog api={{ cancelTask, listTasks } as unknown as GitCrestApiClient} operation="pull" targets={[
    { id: "a", name: "alpha", submit: first }, { id: "b", name: "beta", submit: next },
  ]} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm and run" }));
  await waitFor(() => expect(first).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Stop remaining operations" }));
  await waitFor(() => expect(cancelTask).toHaveBeenCalledWith("first"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop remaining operations" })).toBeNull());
  expect(next).not.toHaveBeenCalled();
});
