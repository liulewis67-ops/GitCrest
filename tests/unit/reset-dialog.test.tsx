// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BranchSnapshotResponse, ResetPreviewResponse, TaskSnapshotResponse } from "../../src/api/client";
import { ResetDialog } from "../../src/features/workflows/ui/ResetDialog";

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
  repoId: "repo_fixture", current: "feature", detached: false,
  branches: [
    { name: "feature", fullName: "feature", oid: "a".repeat(40), kind: "local", isCurrent: true, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null },
    { name: "main", fullName: "main", oid: "b".repeat(40), kind: "local", isCurrent: false, isFavorite: false, upstream: null, upstreamGone: false, ahead: 0, behind: 0 },
  ],
};

const preview: ResetPreviewResponse = {
  repoId: "repo_fixture", expectedHeadOid: "a".repeat(40), targetOid: "b".repeat(40), currentBranch: "feature",
  mode: "mixed", commitsRemoved: 2, commitsAdded: 0, affectedPaths: ["src/file.ts"], omittedPathCount: 0,
  dirtyPaths: [], operationInProgress: null, previewRevision: `sha256:${"c".repeat(64)}`, canStart: true,
};

const task: TaskSnapshotResponse = {
  taskId: "task-reset", repoId: "repo_fixture", targetPath: null, resultRepoId: null, operation: "reset",
  status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [],
  createdAtMs: 1, updatedAtMs: 1, cancelRequested: false,
};

it("previews reset impact and requires explicit confirmation before starting", async () => {
  const api = cancellableApi({
    getRepositoryResetBackups: vi.fn().mockResolvedValue({ headOid: preview.expectedHeadOid, currentBranch: "feature", dirtyPaths: [], operationInProgress: null, backups: [], canRestore: false }),
    preflightRepositoryReset: vi.fn().mockResolvedValue(preview),
    startRepositoryReset: vi.fn().mockResolvedValue(task),
  });
  const onStarted = vi.fn();
  render(<ResetDialog api={api} repoId="repo_fixture" branches={branches} disabled={false} onClose={vi.fn()} onStarted={onStarted} />);

  fireEvent.change(screen.getByLabelText(/Move feature to/), { target: { value: preview.targetOid } });
  fireEvent.click(screen.getByRole("button", { name: "Review impact" }));
  expect(await screen.findByText("src/file.ts")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Reset impact explanation" }).textContent).toContain("2 commit(s) from the current branch history");
  expect(screen.getByRole("region", { name: "Reset impact explanation" }).textContent).toContain("Mixed reset replaces the index");
  const reset = screen.getByRole("button", { name: "Reset mixed" }) as HTMLButtonElement;
  expect(reset.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I reviewed the commit and path impact/));
  fireEvent.click(reset);

  await waitFor(() => expect(api.startRepositoryReset).toHaveBeenCalledWith("repo_fixture", {
    expectedHeadOid: preview.expectedHeadOid,
    targetOid: preview.targetOid,
    mode: "mixed",
    previewRevision: preview.previewRevision,
    confirmReset: true,
  }));
  expect(onStarted).toHaveBeenCalledWith(task);
});

it("does not enable hard reset over local modifications", async () => {
  const api = cancellableApi({
    getRepositoryResetBackups: vi.fn().mockResolvedValue({ headOid: preview.expectedHeadOid, currentBranch: "feature", dirtyPaths: [], operationInProgress: null, backups: [], canRestore: false }),
    preflightRepositoryReset: vi.fn().mockResolvedValue({ ...preview, mode: "hard", dirtyPaths: ["notes.txt"], canStart: false }),
    startRepositoryReset: vi.fn(),
  });
  render(<ResetDialog api={api} repoId="repo_fixture" branches={branches} disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);

  fireEvent.change(screen.getByLabelText(/Move feature to/), { target: { value: preview.targetOid } });
  fireEvent.change(screen.getByLabelText("Reset mode"), { target: { value: "hard" } });
  fireEvent.click(screen.getByRole("button", { name: "Review impact" }));
  expect(await screen.findByText(/This reset cannot start/)).toBeTruthy();
  expect(screen.getByRole("region", { name: "Reset impact explanation" }).textContent).toContain("Hard reset replaces tracked checked-out files");
  expect(screen.getByRole("region", { name: "Reset impact explanation" }).textContent).toContain("1 local changed path(s)");
  expect(await screen.findByText(/hard reset is disabled/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Reset hard" }) as HTMLButtonElement).disabled).toBe(true);
});

it("requires confirmation before restoring a reset backup", async () => {
  const backupSnapshot = {
    headOid: preview.expectedHeadOid, currentBranch: "feature", dirtyPaths: [], operationInProgress: null,
    backups: [{ reference: "refs/gitcrest/reset-backups/task-1", oid: "d".repeat(40), subject: "feature commit" }],
    canRestore: true,
  };
  const api = cancellableApi({
    getRepositoryResetBackups: vi.fn().mockResolvedValue(backupSnapshot),
    restoreRepositoryReset: vi.fn().mockResolvedValue(task),
  });
  const onStarted = vi.fn();
  render(<ResetDialog api={api} repoId="repo_fixture" branches={branches} disabled={false} onClose={vi.fn()} onStarted={onStarted} />);

  const restore = await screen.findByRole("button", { name: "Restore selected reset backup" });
  expect((restore as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/replaces the current branch and checked-out files/));
  fireEvent.click(restore);
  await waitFor(() => expect(api.restoreRepositoryReset).toHaveBeenCalledWith("repo_fixture", {
    expectedHeadOid: preview.expectedHeadOid,
    backupReference: backupSnapshot.backups[0]!.reference,
    backupOid: backupSnapshot.backups[0]!.oid,
    confirmRestore: true,
  }));
  expect(onStarted).toHaveBeenCalledWith(task);
});

it("moves focus into the reset dialog and closes it with Escape", async () => {
  const onClose = vi.fn();
  const api = cancellableApi({
    getRepositoryResetBackups: vi.fn().mockResolvedValue({ headOid: preview.expectedHeadOid, currentBranch: "feature", dirtyPaths: [], operationInProgress: null, backups: [], canRestore: false }),
  });
  render(<ResetDialog api={api} repoId="repo_fixture" branches={branches} disabled={false} onClose={onClose} onStarted={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Reset current branch" });
  const target = screen.getByRole("dialog").querySelector("#reset-target");
  await waitFor(() => expect(document.activeElement).toBe(target));

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});

it("aborts a reset backup read when the dialog unmounts", async () => {
  const pending = deferred<Awaited<ReturnType<import("../../src/api/client").GitCrestApiClient["getRepositoryResetBackups"]>>>();
  const signals: AbortSignal[] = [];
  let api: Record<string, unknown>;
  api = {
    withSignal: vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return api;
    }),
    getRepositoryResetBackups: vi.fn(() => pending.promise),
  };
  const client = api as unknown as import("../../src/api/client").GitCrestApiClient;
  const { unmount } = render(<ResetDialog api={client} repoId="repo_fixture" branches={branches} disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);
  await waitFor(() => expect(signals).toHaveLength(1));
  unmount();
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => pending.resolve({ headOid: preview.expectedHeadOid, currentBranch: "feature", dirtyPaths: [], operationInProgress: null, backups: [], canRestore: false }));
});

it("preselects a history commit that no branch points at and previews it", async () => {
  const target = "d".repeat(40);
  const api = cancellableApi({
    getRepositoryResetBackups: vi.fn().mockResolvedValue({ headOid: preview.expectedHeadOid, currentBranch: "feature", dirtyPaths: [], operationInProgress: null, backups: [], canRestore: false }),
    preflightRepositoryReset: vi.fn().mockResolvedValue({ ...preview, targetOid: target }),
  });
  render(<ResetDialog api={api} repoId="repo_fixture" branches={branches} initialTargetOid={target} disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);

  expect((screen.getByLabelText(/Move feature to/) as HTMLSelectElement).value).toBe(target);
  fireEvent.click(screen.getByRole("button", { name: "Review impact" }));
  await waitFor(() => expect(api.preflightRepositoryReset).toHaveBeenCalledWith("repo_fixture", target, "mixed"));
});
