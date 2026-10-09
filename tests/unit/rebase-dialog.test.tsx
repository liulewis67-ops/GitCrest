// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BranchSnapshotResponse, RebasePreviewResponse, TaskSnapshotResponse } from "../../src/api/client";
import { RebaseDialog } from "../../src/features/workflows/RebaseDialog";

afterEach(cleanup);

function cancellableApi(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as import("../../src/api/client").GitCrestApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

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

const backups = {
  headOid: "a".repeat(40), currentBranch: "feature", dirtyPaths: [], operationInProgress: null,
  backups: [{ reference: "refs/gitcrest/rebase-backups/task-1", oid: "b".repeat(40), subject: "before rewrite" }],
  canRollback: true,
};

it("reviews an editable todo and requires confirmation for drops and published rewrites", async () => {
  const api = cancellableApi({
    getRepositoryRebaseBackups: vi.fn().mockResolvedValue(backups),
    preflightRepositoryRebase: vi.fn().mockResolvedValue(preview),
    startRepositoryRebase: vi.fn().mockResolvedValue(task),
  });
  const onStarted = vi.fn();
  render(<RebaseDialog api={api} repoId="repo_fixture" branches={branches} disabled={false} onClose={vi.fn()} onStarted={onStarted} />);

  expect((screen.getByLabelText("Rebase current branch onto") as HTMLSelectElement).value).toBe("b".repeat(40));
  fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
  expect(await screen.findByText("first feature")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Rebase impact explanation" }).textContent).toContain("feature will replay the reviewed todo");
  expect(screen.getByRole("region", { name: "Rebase impact explanation" }).textContent).toContain("1 previewed commit(s) are already reachable");
  fireEvent.change(screen.getByLabelText(`Action for ${preview.commits[0]!.oid.slice(0, 9)}`), { target: { value: "reword" } });
  fireEvent.change(screen.getByLabelText(`Action for ${preview.commits[1]!.oid.slice(0, 9)}`), { target: { value: "drop" } });
  expect(screen.getByRole("region", { name: "Rebase impact explanation" }).textContent).toContain("1 commit(s) marked drop will not be replayed");
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

it("requires a separate confirmation before restoring a saved backup", async () => {
  const api = cancellableApi({
    getRepositoryRebaseBackups: vi.fn().mockResolvedValue(backups),
    rollbackRepositoryRebase: vi.fn().mockResolvedValue(task),
  });
  const onStarted = vi.fn();
  render(<RebaseDialog api={api} repoId="repo_fixture" branches={branches} disabled={false} onClose={vi.fn()} onStarted={onStarted} />);

  const restore = await screen.findByRole("button", { name: "Restore selected backup" });
  expect((restore as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/moves the current branch/));
  expect((restore as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(restore);

  await waitFor(() => expect(api.rollbackRepositoryRebase).toHaveBeenCalledWith("repo_fixture", {
    expectedHeadOid: backups.headOid,
    backupReference: backups.backups[0]!.reference,
    backupOid: backups.backups[0]!.oid,
    confirmRollback: true,
  }));
  expect(onStarted).toHaveBeenCalledWith(task);
});

it("moves focus into the rebase dialog and closes it with Escape", async () => {
  const onClose = vi.fn();
  const api = cancellableApi({
    getRepositoryRebaseBackups: vi.fn().mockResolvedValue({ ...backups, backups: [] }),
  });
  render(<RebaseDialog api={api} repoId="repo_fixture" branches={branches} disabled={false} onClose={onClose} onStarted={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Interactive rebase" });
  const close = screen.getByRole("button", { name: "Close" });
  await waitFor(() => expect(document.activeElement).toBe(close));

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});

it("aborts a rebase backup read when the dialog unmounts", async () => {
  const pending = deferred<Awaited<ReturnType<import("../../src/api/client").GitCrestApiClient["getRepositoryRebaseBackups"]>>>();
  const signals: AbortSignal[] = [];
  let api: Record<string, unknown>;
  api = {
    withSignal: vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return api;
    }),
    getRepositoryRebaseBackups: vi.fn(() => pending.promise),
  };
  const client = api as unknown as import("../../src/api/client").GitCrestApiClient;
  const { unmount } = render(<RebaseDialog api={client} repoId="repo_fixture" branches={branches} disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);
  await waitFor(() => expect(signals).toHaveLength(1));
  unmount();
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => pending.resolve({ ...backups, backups: [] }));
});
