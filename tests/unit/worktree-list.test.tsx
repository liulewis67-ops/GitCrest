// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, WorktreeSnapshotResponse } from "../../src/api/client";
import { WorktreeList } from "../../src/features/branches/ui/WorktreeList";
import { RemoveWorktreeDialog } from "../../src/features/branches/ui/RemoveWorktreeDialog";

afterEach(cleanup);

type Worktree = WorktreeSnapshotResponse["worktrees"][number];

function worktree(path: string, extra: Partial<Worktree> = {}): Worktree {
  return { path, head: "a".repeat(40), branch: null, detached: false, locked: false, prunable: false, isCurrent: false, isMain: false, isDirty: false, ...extra };
}

const snapshot: WorktreeSnapshotResponse = {
  repoId: "repo",
  worktrees: [
    worktree("C:/work/app", { branch: "main", isMain: true, isCurrent: true }),
    worktree("C:/work/app-feature", { branch: "feature/x", head: "b".repeat(40), isDirty: true }),
    worktree("C:/work/app-gone", { branch: "old", prunable: true }),
  ],
};

function apiWith(overrides: Record<string, unknown> = {}) {
  const scoped = { getRepositoryWorktrees: vi.fn().mockResolvedValue(snapshot), previewRepositoryBranchDelete: vi.fn().mockResolvedValue({ name: "feature/x", isCurrent: false, unmergedCommitCount: 2, requiresConfirmation: true }) };
  const api = { ...scoped, withSignal: () => api, pruneRepositoryWorktrees: vi.fn().mockResolvedValue({ taskId: "prune" }), removeRepositoryWorktree: vi.fn().mockResolvedValue({ taskId: "remove" }), ...overrides };
  return api as typeof api & GitCrestApiClient;
}

function openMenu(label: string) {
  fireEvent.contextMenu(screen.getByText(label).closest("li")!, { clientX: 30, clientY: 40 });
  return screen.getByRole("menu");
}

it("puts open, new worktree, reveal, copy and remove on a worktree's right-click menu", async () => {
  const handlers = { onOpen: vi.fn(), onNewWorktreeFrom: vi.fn(), onRemove: vi.fn(), onReveal: vi.fn(), onPruneStarted: vi.fn() };
  render(<WorktreeList api={apiWith()} repoId="repo" refreshKey={0} disabled={false} {...handlers} />);
  await screen.findByText("feature/x");

  const menu = openMenu("feature/x");
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Open worktree", "New worktree from here…", expect.stringMatching(/^Show in|^Reveal in/), "Copy Path", "Remove worktree…",
  ]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "New worktree from here…" }));
  expect(handlers.onNewWorktreeFrom).toHaveBeenCalledWith("b".repeat(40), "feature/x");
  fireEvent.click(within(openMenu("feature/x")).getByRole("menuitem", { name: "Remove worktree…" }));
  expect(handlers.onRemove).toHaveBeenCalledWith("C:/work/app-feature");

  // The worktree open in this tab, like the main one, explains why it cannot be removed.
  const current = within(openMenu("main")).getByRole("menuitem", { name: "Remove worktree…" }) as HTMLButtonElement;
  expect(current.disabled).toBe(true);
  expect(current.title).toMatch(/main working tree/);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

  fireEvent.click(within(openMenu("old")).getByRole("menuitem", { name: "Clean up missing worktrees" }));
  await waitFor(() => expect(handlers.onPruneStarted).toHaveBeenCalledWith({ taskId: "prune" }));
});

it("asks before removing a dirty worktree and deletes its unmerged branch only when told to", async () => {
  const api = apiWith();
  const onStarted = vi.fn();
  render(<RemoveWorktreeDialog api={api} repoId="repo" path="C:\work\app-feature\\" disabled={false} onClose={vi.fn()} onStarted={onStarted} />);

  const remove = await screen.findByRole("button", { name: "Remove worktree" }) as HTMLButtonElement;
  await screen.findByText(/has uncommitted changes/);
  expect(remove.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /discard them/ }));
  expect(remove.disabled).toBe(false);

  fireEvent.click(screen.getByRole("checkbox", { name: "Also delete the branch feature/x" }));
  const both = screen.getByRole("button", { name: "Remove worktree and branch" }) as HTMLButtonElement;
  await waitFor(() => expect(api.previewRepositoryBranchDelete).toHaveBeenCalledWith("repo", "feature/x"));
  expect(both.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /2 commit\(s\).*Delete it anyway/ }));
  expect(both.disabled).toBe(false);
  fireEvent.click(both);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ taskId: "remove" }));
  expect(api.removeRepositoryWorktree).toHaveBeenCalledWith("repo", "C:/work/app-feature", true, { deleteBranch: true, allowUnmerged: true });
});

it("allows force removal of a clean worktree", async () => {
  const api = apiWith({ getRepositoryWorktrees: vi.fn().mockResolvedValue({
    ...snapshot, worktrees: [worktree("C:/work/clean")],
  }) });
  render(<RemoveWorktreeDialog api={api} repoId="repo" path="C:/work/clean" disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /Force removal/ }));
  fireEvent.click(screen.getByRole("button", { name: "Remove worktree" }));
  await waitFor(() => expect(api.removeRepositoryWorktree).toHaveBeenCalledWith(
    "repo", "C:/work/clean", true, { deleteBranch: false, allowUnmerged: false },
  ));
});
