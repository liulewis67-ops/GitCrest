// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { WorkflowDialog } from "../../src/features/workflows/WorkflowDialog";

afterEach(cleanup);

it("requires a fresh allowed preflight before starting a commit workflow", async () => {
  const preflight = {
    repoId: "repo_fixture", action: "merge" as const, headOid: "b".repeat(40), targetOid: "a".repeat(40), targetSubject: "Merge this change",
    operationInProgress: null, isClean: true, dirtyPaths: [], omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0, canStart: true,
  };
  const task = { taskId: "task-merge", operation: "merge" } as Awaited<ReturnType<GitCrestApiClient["startRepositoryWorkflow"]>>;
  const api = {
    preflightRepositoryWorkflow: vi.fn().mockResolvedValue(preflight),
    startRepositoryWorkflow: vi.fn().mockResolvedValue(task),
  } as unknown as GitCrestApiClient;
  const onStarted = vi.fn();
  render(<WorkflowDialog api={api} repoId="repo_fixture" targetOid={preflight.targetOid} action="merge" onClose={vi.fn()} onStarted={onStarted} />);
  const start = await screen.findByRole("button", { name: "Start merge" });
  expect(start).not.toHaveProperty("disabled", true);
  fireEvent.click(start);
  await waitFor(() => expect(api.startRepositoryWorkflow).toHaveBeenCalledWith("repo_fixture", {
    action: "merge", targetOid: preflight.targetOid, expectedHeadOid: preflight.headOid,
  }));
  expect(onStarted).toHaveBeenCalledWith(task);
});

it("keeps a blocked workflow unavailable", async () => {
  const api = {
    preflightRepositoryWorkflow: vi.fn().mockResolvedValue({
      repoId: "repo_fixture", action: "revert", headOid: "b".repeat(40), targetOid: "a".repeat(40), targetSubject: "Change",
      operationInProgress: null, isClean: false, dirtyPaths: ["draft.txt"], omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0, canStart: false,
    }),
    startRepositoryWorkflow: vi.fn(),
  } as unknown as GitCrestApiClient;
  render(<WorkflowDialog api={api} repoId="repo_fixture" targetOid={"a".repeat(40)} action="revert" onClose={vi.fn()} onStarted={vi.fn()} />);
  expect(await screen.findByText(/Working tree has 1 change/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start revert" }).hasAttribute("disabled")).toBe(true);
  expect(api.startRepositoryWorkflow).not.toHaveBeenCalled();
});
