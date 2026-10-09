// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskSnapshotResponse } from "../../src/api/client";
import { TaskCenter } from "../../src/features/tasks/TaskCenter";

afterEach(cleanup);

function cancellableApi(methods: Record<string, unknown>, signals: AbortSignal[] = []) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn((signal: AbortSignal) => { signals.push(signal); return api; }) };
  return api as unknown as import("../../src/api/client").GitCrestApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

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
  render(<TaskCenter tasks={[failedFetch]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={onConfigureCredentials} onReviewPush={vi.fn()} onRecoverWorkflow={vi.fn()} onOpenConflictWindow={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Configure credentials" }));
  expect(onConfigureCredentials).toHaveBeenCalledWith(failedFetch);
});

it("announces each task status without making the entire task list a live region", () => {
  const { container, rerender } = render(<TaskCenter tasks={[failedFetch]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={vi.fn()} onRecoverWorkflow={vi.fn()} onOpenConflictWindow={vi.fn()} />);
  const taskList = container.querySelector(".taskList");
  expect(taskList?.hasAttribute("aria-live")).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("failed");

  rerender(<TaskCenter tasks={[{ ...failedFetch, status: "succeeded", phase: "Completed", message: "Fetch completed" }]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={vi.fn()} onRecoverWorkflow={vi.fn()} onOpenConflictWindow={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toBe("succeeded");
});

it("moves focus into the task center and closes it with Escape", async () => {
  const onClose = vi.fn();
  render(<TaskCenter tasks={[]} error="" actionId="" onClose={onClose} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={vi.fn()} onRecoverWorkflow={vi.fn()} onOpenConflictWindow={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Tasks" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh" })));

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});

it("does not show credential recovery for unrelated task failures", () => {
  const unrelated = { ...failedFetch, operation: "commit", errorCategory: "commandFailed" as const, logs: ["hook rejected commit"] };
  render(<TaskCenter tasks={[unrelated]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={vi.fn()} onRecoverWorkflow={vi.fn()} onOpenConflictWindow={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Configure credentials" })).toBeNull();
});

it("offers a reviewed retry for a rejected push", () => {
  const onReviewPush = vi.fn();
  const rejected = { ...failedFetch, operation: "pushForceWithLease", errorCategory: "pushRejected" as const, logs: ["! [rejected] main -> main (stale info)"] };
  render(<TaskCenter tasks={[rejected]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={onReviewPush} onRecoverWorkflow={vi.fn()} onOpenConflictWindow={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Review and retry push" }));
  expect(onReviewPush).toHaveBeenCalledWith(rejected);
});

it("keeps a failed commit-and-push retry scoped to push", () => {
  const onReviewPush = vi.fn();
  const failedPush = { ...failedFetch, taskId: "task-push", operation: "push", errorCategory: "network" as const, message: "Network unavailable" };
  render(<TaskCenter tasks={[failedPush]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={onReviewPush} onRecoverWorkflow={vi.fn()} onOpenConflictWindow={vi.fn()} />);
  expect(screen.getByText(/The commit is still saved locally/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review and retry push" }));
  expect(onReviewPush).toHaveBeenCalledWith(failedPush);
});

it("lists workflow conflicts and offers safe recovery actions", async () => {
  const waiting = { ...failedFetch, taskId: "task-merge", operation: "merge", status: "waitingForInput" as const, message: "Resolve conflicts" };
  const preflight = {
    repoId: "repo_fixture", taskId: waiting.taskId, operation: "merge" as const, headOid: "a".repeat(40),
    dirtyPaths: ["src/conflict.ts"], omittedDirtyPathCount: 0, conflictedPaths: ["src/conflict.ts"], omittedConflictedPathCount: 0,
    canContinue: false, canSkip: false, canAbort: true,
  };
  const resolvedPreflight = { ...preflight, conflictedPaths: [], canContinue: true };
  const api = cancellableApi({ preflightRepositoryWorkflowRecovery: vi.fn().mockResolvedValueOnce(preflight).mockResolvedValue(resolvedPreflight) });
  const onRecoverWorkflow = vi.fn();
  const onOpenConflictWindow = vi.fn();
  render(<TaskCenter api={api} tasks={[waiting]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={vi.fn()} onRecoverWorkflow={onRecoverWorkflow} onOpenConflictWindow={onOpenConflictWindow} />);
  expect(await screen.findByText("src/conflict.ts")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open conflict resolver" }));
  expect(onOpenConflictWindow).toHaveBeenCalledWith(waiting);
  fireEvent.focus(window);
  expect(await screen.findByText("No unresolved conflicts remain.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Abort…" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm abort" }));
  await waitFor(() => expect(onRecoverWorkflow).toHaveBeenCalledWith(waiting, resolvedPreflight, "abort"));
  expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
});

it("offers rebase recovery and skip while a rebase waits for input", async () => {
  const waiting = { ...failedFetch, taskId: "task-rebase", operation: "rebase", status: "waitingForInput" as const, message: "Resolve rebase conflicts" };
  const preview = {
    repoId: "repo_fixture", taskId: waiting.taskId, operation: "rebase" as const, headOid: "a".repeat(40),
    dirtyPaths: ["notes.txt"], omittedDirtyPathCount: 0, conflictedPaths: ["notes.txt"], omittedConflictedPathCount: 0,
    canContinue: false, canSkip: true, canAbort: true,
  };
  const api = cancellableApi({ preflightRepositoryWorkflowRecovery: vi.fn().mockResolvedValue(preview) });
  const onRecoverWorkflow = vi.fn();
  render(<TaskCenter api={api} tasks={[waiting]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={vi.fn()} onRecoverWorkflow={onRecoverWorkflow} onOpenConflictWindow={vi.fn()} />);
  expect(await screen.findByText("notes.txt")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(onRecoverWorkflow).toHaveBeenCalledWith(waiting, preview, "skip");
});

it("offers conflict recovery for a pull-merge task", async () => {
  const waiting = { ...failedFetch, taskId: "task-pull-merge", operation: "pullMerge", status: "waitingForInput" as const, message: "Resolve pull conflicts" };
  const preview = {
    repoId: "repo_fixture", taskId: waiting.taskId, operation: "merge" as const, headOid: "b".repeat(40),
    dirtyPaths: ["src/conflict.ts"], omittedDirtyPathCount: 0, conflictedPaths: ["src/conflict.ts"], omittedConflictedPathCount: 0,
    canContinue: false, canSkip: false, canAbort: true,
  };
  const api = cancellableApi({ preflightRepositoryWorkflowRecovery: vi.fn().mockResolvedValue(preview) });
  const onOpenConflictWindow = vi.fn();
  render(<TaskCenter api={api} tasks={[waiting]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={vi.fn()} onRecoverWorkflow={vi.fn()} onOpenConflictWindow={onOpenConflictWindow} />);
  expect(await screen.findByText("src/conflict.ts")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open conflict resolver" }));
  expect(onOpenConflictWindow).toHaveBeenCalledWith(waiting);
});

it("aborts replaced workflow recovery previews and cancels on unmount", async () => {
  const waiting = { ...failedFetch, taskId: "task-merge", operation: "merge", status: "waitingForInput" as const, message: "Resolve conflicts" };
  const first = deferred<Awaited<ReturnType<import("../../src/api/client").GitCrestApiClient["preflightRepositoryWorkflowRecovery"]>>>();
  const second = deferred<Awaited<ReturnType<import("../../src/api/client").GitCrestApiClient["preflightRepositoryWorkflowRecovery"]>>>();
  const signals: AbortSignal[] = [];
  const preflight = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const api = cancellableApi({ preflightRepositoryWorkflowRecovery: preflight }, signals);
  const { unmount } = render(<TaskCenter api={api} tasks={[waiting]} error="" actionId="" onClose={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} onCopy={vi.fn()} onRetryClone={vi.fn()} onConfigureCredentials={vi.fn()} onReviewPush={vi.fn()} onRecoverWorkflow={vi.fn()} onOpenConflictWindow={vi.fn()} />);
  await waitFor(() => expect(preflight).toHaveBeenCalledTimes(1));

  fireEvent.focus(window);
  await waitFor(() => expect(preflight).toHaveBeenCalledTimes(2));
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => first.resolve({
    repoId: "repo_fixture", taskId: waiting.taskId, operation: "merge", headOid: "a".repeat(40),
    dirtyPaths: [], omittedDirtyPathCount: 0, conflictedPaths: ["stale.ts"], omittedConflictedPathCount: 0,
    canContinue: false, canSkip: false, canAbort: true,
  }));
  expect(screen.queryByText("stale.ts")).toBeNull();

  unmount();
  expect(signals[1]?.aborted).toBe(true);
  await act(async () => second.resolve({
    repoId: "repo_fixture", taskId: waiting.taskId, operation: "merge", headOid: "a".repeat(40),
    dirtyPaths: [], omittedDirtyPathCount: 0, conflictedPaths: ["late.ts"], omittedConflictedPathCount: 0,
    canContinue: false, canSkip: false, canAbort: true,
  }));
});
