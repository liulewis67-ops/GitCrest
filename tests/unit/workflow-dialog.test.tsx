// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { WorkflowDialog } from "../../src/features/workflows/ui/WorkflowDialog";

afterEach(cleanup);

function cancellableApi(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

it("requires a fresh allowed preflight before starting a commit workflow", async () => {
  const preflight = {
    repoId: "repo_fixture", action: "merge" as const, headOid: "b".repeat(40), targetOid: "a".repeat(40), targetSubject: "Merge this change",
    operationInProgress: null, isClean: true, dirtyPaths: [], omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0, canStart: true,
  };
  const task = { taskId: "task-merge", operation: "merge" } as Awaited<ReturnType<GitCrestApiClient["startRepositoryWorkflow"]>>;
  const api = cancellableApi({
    preflightRepositoryWorkflow: vi.fn().mockResolvedValue(preflight),
    startRepositoryWorkflow: vi.fn().mockResolvedValue(task),
  });
  const onStarted = vi.fn();
  render(<WorkflowDialog api={api} repoId="repo_fixture" targetOid={preflight.targetOid} action="merge" onClose={vi.fn()} onStarted={onStarted} />);
  const start = await screen.findByRole("button", { name: "Start merge" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Start merge" })).not.toHaveProperty("disabled", true));
  fireEvent.click(start);
  await waitFor(() => expect(api.startRepositoryWorkflow).toHaveBeenCalledWith("repo_fixture", {
    action: "merge", targetOid: preflight.targetOid, expectedHeadOid: preflight.headOid,
  }));
  expect(onStarted).toHaveBeenCalledWith(task);
});

it("keeps a blocked workflow unavailable", async () => {
  const api = cancellableApi({
    preflightRepositoryWorkflow: vi.fn().mockResolvedValue({
      repoId: "repo_fixture", action: "revert", headOid: "b".repeat(40), targetOid: "a".repeat(40), targetSubject: "Change",
      operationInProgress: null, isClean: false, dirtyPaths: ["draft.txt"], omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0, canStart: false,
    }),
    startRepositoryWorkflow: vi.fn(),
  });
  render(<WorkflowDialog api={api} repoId="repo_fixture" targetOid={"a".repeat(40)} action="revert" onClose={vi.fn()} onStarted={vi.fn()} />);
  expect(await screen.findByText(/Working tree has 1 change/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start revert" }).hasAttribute("disabled")).toBe(true);
  expect(api.startRepositoryWorkflow).not.toHaveBeenCalled();
});

it("moves focus into the workflow dialog and closes it with Escape", async () => {
  const api = cancellableApi({
    preflightRepositoryWorkflow: vi.fn().mockResolvedValue({
      repoId: "repo_fixture", action: "merge", headOid: "b".repeat(40), targetOid: "a".repeat(40), targetSubject: "Merge this change",
      operationInProgress: null, isClean: true, dirtyPaths: [], omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0, canStart: true,
    }),
  });
  const onClose = vi.fn();
  const { container } = render(<WorkflowDialog api={api} repoId="repo_fixture" targetOid={"a".repeat(40)} action="merge" onClose={onClose} onStarted={vi.fn()} />);
  const dialog = await screen.findByRole("dialog", { name: "Merge commit" });
  const close = screen.getByRole("button", { name: "Close" });
  await waitFor(() => expect(document.activeElement).toBe(close));
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
});

it("aborts the previous preflight and ignores it after the target changes", async () => {
  const first = deferred<Awaited<ReturnType<GitCrestApiClient["preflightRepositoryWorkflow"]>>>();
  const second = {
    repoId: "repo_fixture", action: "merge" as const, headOid: "c".repeat(40), targetOid: "d".repeat(40), targetSubject: "New target",
    operationInProgress: null, isClean: true, dirtyPaths: [], omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0, canStart: true,
  };
  const signals: AbortSignal[] = [];
  let api: Record<string, unknown>;
  api = {
    withSignal: vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return api;
    }),
    preflightRepositoryWorkflow: vi.fn((_repoId: string, _action: string, targetOid: string) =>
      targetOid === "a".repeat(40) ? first.promise : Promise.resolve(second)),
  };
  const client = api as unknown as GitCrestApiClient;
  const { rerender } = render(<WorkflowDialog api={client} repoId="repo_fixture" targetOid={"a".repeat(40)} action="merge" onClose={vi.fn()} onStarted={vi.fn()} />);
  await waitFor(() => expect(signals).toHaveLength(1));

  rerender(<WorkflowDialog api={client} repoId="repo_fixture" targetOid={second.targetOid} action="merge" onClose={vi.fn()} onStarted={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("New target")).toBeTruthy());
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => first.resolve({
    repoId: "repo_fixture", action: "merge", headOid: "b".repeat(40), targetOid: "a".repeat(40), targetSubject: "Old target",
    operationInProgress: null, isClean: true, dirtyPaths: [], omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0, canStart: true,
  }));
  expect(screen.queryByText("Old target")).toBeNull();
  expect(screen.getByText("New target")).toBeTruthy();
});
