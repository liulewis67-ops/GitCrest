// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskSnapshotResponse } from "../../src/api/client";
import { TaskCenter } from "../../src/features/tasks/TaskCenter";

afterEach(cleanup);

const failedFetch: TaskSnapshotResponse = {
  taskId: "task-auth",
  repoId: "repo_fixture",
  targetPath: null,
  resultRepoId: null,
  operation: "fetch",
  status: "failed",
  phase: "Failed",
  progress: null,
  message: "Git command failed with exit code 128",
  errorCategory: "authentication",
  logs: ["fatal: Authentication failed for 'https://example.test/org/repo.git'"],
  createdAtMs: 1,
  updatedAtMs: 2,
  cancelRequested: false,
};

it("provides a recovery action for an authentication-failed fetch", () => {
  const onConfigureCredentials = vi.fn();
  render(<TaskCenter tasks={[failedFetch]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={onConfigureCredentials} onReviewPush={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Configure credentials" }));
  expect(onConfigureCredentials).toHaveBeenCalledWith(failedFetch);
});

it("does not show credential recovery for unrelated task failures", () => {
  const unrelated = { ...failedFetch, operation: "commit", errorCategory: "commandFailed" as const, logs: ["hook rejected commit"] };
  render(<TaskCenter tasks={[unrelated]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Configure credentials" })).toBeNull();
});

it("offers a reviewed retry for a rejected push", () => {
  const onReviewPush = vi.fn();
  const rejected = { ...failedFetch, operation: "pushForceWithLease", errorCategory: "pushRejected" as const, logs: ["! [rejected] main -> main (stale info)"] };
  render(<TaskCenter tasks={[rejected]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={onReviewPush} />);
  fireEvent.click(screen.getByRole("button", { name: "Review and retry push" }));
  expect(onReviewPush).toHaveBeenCalledWith(rejected);
});

it("keeps a failed commit-and-push retry scoped to push", () => {
  const onReviewPush = vi.fn();
  const failedPush = { ...failedFetch, taskId: "task-push", operation: "push", errorCategory: "network" as const, message: "Network unavailable" };
  render(<TaskCenter tasks={[failedPush]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={onReviewPush} />);
  expect(screen.getByText(/The commit is still saved locally/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review and retry push" }));
  expect(onReviewPush).toHaveBeenCalledWith(failedPush);
});
