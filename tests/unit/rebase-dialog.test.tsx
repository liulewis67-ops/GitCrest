// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BranchSnapshotResponse, RebasePreviewResponse, TaskSnapshotResponse } from "../../src/api/client";
import { RebaseDialog } from "../../src/features/workflows/RebaseDialog";

afterEach(cleanup);

const branches: BranchSnapshotResponse = {
  repoId: "repo_fixture",
  current: "feature",
  detached: false,
  branches: [
    { name: "feature", fullName: "feature", oid: "a".repeat(40), kind: "local", isCurrent: true, isFavorite: false, upstream: "origin/feature", upstreamGone: false, ahead: 2, behind: 0 },
    { name: "feature", fullName: "origin/feature", oid: "b".repeat(40), kind: "remote", isCurrent: false, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null },
    { name: "main", fullName: "main", oid: "c".repeat(40), kind: "local", isCurrent: false, isFavorite: false, upstream: null, upstreamGone: false, ahead: 0, behind: 0 },
  ],
};

const preview: RebasePreviewResponse = {
  repoId: "repo_fixture", headOid: "a".repeat(40), ontoOid: "b".repeat(40), currentBranch: "feature",
  commits: [
    { oid: "d".repeat(40), subject: "first feature" },
    { oid: "e".repeat(40), subject: "second feature" },
  ],
  omittedCommitCount: 0, publishedCommitOids: ["d".repeat(40)], dirtyPaths: [], omittedDirtyPathCount: 0,
  operationInProgress: null, previewRevision: `sha256:${"f".repeat(64)}`, canStart: true,
};

const task: TaskSnapshotResponse = {
  taskId: "task-rebase", repoId: "repo_fixture", targetPath: null, resultRepoId: null, operation: "rebase",
  status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [],
  createdAtMs: 1, updatedAtMs: 1, cancelRequested: false,
};

it("reviews an editable todo and requires confirmation for drops and published rewrites", async () => {
  const api = {
    preflightRepositoryRebase: vi.fn().mockResolvedValue(preview),
    startRepositoryRebase: vi.fn().mockResolvedValue(task),
  } as unknown as import("../../src/api/client").GitCrestApiClient;
  const onStarted = vi.fn();
  render(<RebaseDialog api={api} repoId="repo_fixture" branches={branches} disabled={false} onClose={vi.fn()} onStarted={onStarted} />);

  expect((screen.getByLabelText("Rebase current branch onto") as HTMLSelectElement).value).toBe("b".repeat(40));
  fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
  expect(await screen.findByText("first feature")).toBeTruthy();
  const actions = screen.getAllByRole("combobox").slice(1);
  fireEvent.change(actions[0]!, { target: { value: "reword" } });
  fireEvent.change(actions[1]!, { target: { value: "drop" } });
  expect((screen.getByLabelText(/Replacement message/) as HTMLTextAreaElement).value).toBe("first feature");
  expect((screen.getByRole("button", { name: "Start rebase" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(screen.getByLabelText(/already reachable from a remote/));
  expect((screen.getByRole("button", { name: "Start rebase" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/dropped commit/));
  expect((screen.getByRole("button", { name: "Start rebase" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Start rebase" }));

  await waitFor(() => expect(api.startRepositoryRebase).toHaveBeenCalledOnce());
  expect(api.startRepositoryRebase).toHaveBeenCalledWith("repo_fixture", expect.objectContaining({
    expectedHeadOid: preview.headOid,
    expectedOntoOid: preview.ontoOid,
    previewRevision: preview.previewRevision,
    confirmDrop: true,
    confirmPublishedRewrite: true,
    todo: [
      { oid: preview.commits[0]!.oid, action: "reword", message: "first feature" },
      { oid: preview.commits[1]!.oid, action: "drop", message: null },
    ],
  }));
  expect(onStarted).toHaveBeenCalledWith(task);
});
