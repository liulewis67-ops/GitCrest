// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, WorktreeSnapshotResponse } from "../../src/api/client";
import { WorktreeSwitcher } from "../../src/features/branches/ui/WorktreeSwitcher";

afterEach(cleanup);

type Worktree = WorktreeSnapshotResponse["worktrees"][number];

function worktree(path: string, branch: string | null, extra: Partial<Worktree> = {}): Worktree {
  return { path, head: "a".repeat(40), branch, detached: false, locked: false, prunable: false, isCurrent: false, isMain: false, isDirty: false, ...extra };
}

function renderSwitcher(worktrees: Worktree[]) {
  const getRepositoryWorktrees = vi.fn().mockResolvedValue({ repoId: "repo", worktrees });
  const api = { withSignal: () => api, getRepositoryWorktrees } as unknown as GitCrestApiClient;
  const onOpen = vi.fn();
  const view = render(<WorktreeSwitcher api={api} repoId="repo" refreshKey={0} disabled={false} onOpen={onOpen} />);
  return { onOpen, getRepositoryWorktrees, view };
}

it("keeps the worktree entry available even before another worktree is created", async () => {
  const { getRepositoryWorktrees } = renderSwitcher([worktree("C:\\work\\app", "main", { isMain: true, isCurrent: true })]);
  await waitFor(() => expect(getRepositoryWorktrees).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("button", { name: /Current worktree.*app/ }));
  expect(screen.getByRole("group", { name: "Main worktree" })).toBeDefined();
});

it("lists the main and linked worktrees and opens the chosen one", async () => {
  const { onOpen } = renderSwitcher([
    worktree("C:\\work\\app", "main", { isMain: true, isCurrent: true }),
    worktree("C:\\work\\app-IT-1", "feature/IT-1", { isDirty: true }),
    worktree("C:\\work\\app-IT-2", "feature/IT-2"),
    worktree("C:\\work\\gone", "feature/old", { prunable: true }),
  ]);
  const button = await screen.findByRole("button", { name: /app/ });
  expect(button.textContent).toContain("app");
  fireEvent.click(button);

  const main = screen.getByRole("group", { name: "Main worktree" });
  const current = within(main).getByRole("menuitemradio", { name: /app/ });
  expect(current.getAttribute("aria-checked")).toBe("true");
  const linked = screen.getByRole("group", { name: "Linked worktrees" });
  expect(within(linked).getAllByRole("menuitemradio")).toHaveLength(3);
  expect((within(linked).getByRole("menuitemradio", { name: /gone/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(linked).getByLabelText("Has uncommitted changes")).toBeDefined();

  fireEvent.click(current);
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.click(button);
  fireEvent.click(within(screen.getByRole("group", { name: "Linked worktrees" })).getByRole("menuitemradio", { name: /app-IT-2/ }));
  expect(onOpen).toHaveBeenLastCalledWith("C:\\work\\app-IT-2");
});

it("filters by folder or branch name and opens the first match with Enter", async () => {
  const { onOpen } = renderSwitcher([
    worktree("/work/app", "main", { isMain: true, isCurrent: true }),
    worktree("/work/app-review", "feature/review"),
    worktree("/work/app-hotfix", "hotfix/login"),
  ]);
  fireEvent.click(await screen.findByRole("button", { name: /app/ }));
  const filter = screen.getByRole("searchbox", { name: "Filter worktrees" });
  await waitFor(() => expect(document.activeElement).toBe(filter));
  fireEvent.keyDown(filter, { key: "Tab" });
  expect(screen.getByRole("menu", { name: "Repository worktrees" })).toBeDefined();
  fireEvent.change(filter, { target: { value: "login" } });
  expect(screen.queryByRole("group", { name: "Main worktree" })).toBeNull();
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(onOpen).toHaveBeenLastCalledWith("/work/app-hotfix");

  fireEvent.click(screen.getByRole("button", { name: /app/ }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter worktrees" }), { target: { value: "nothing" } });
  expect(screen.getByText("No worktree matches “nothing”.")).toBeDefined();
  fireEvent.keyDown(screen.getByRole("searchbox", { name: "Filter worktrees" }), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
});

it("offers batch removal on the selection without opening multiple worktrees", async () => {
  const { onOpen } = renderSwitcher([
    worktree("/work/app", "main", { isMain: true, isCurrent: true }),
    worktree("/work/alpha", "alpha"), worktree("/work/beta", "beta"),
  ]);
  fireEvent.click(await screen.findByRole("button", { name: /Current worktree.*app/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select alpha" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select beta" }));
  expect(onOpen).not.toHaveBeenCalled();
  const row = screen.getByRole("menuitemradio", { name: /alpha/ }).closest(".worktreePickerRow")!;
  fireEvent.contextMenu(row, { clientX: 30, clientY: 80 });
  const menu = screen.getByRole("menu", { name: /alpha/ });
  expect(within(menu).getByRole("menuitem", { name: "Remove selected worktrees" })).toBeDefined();
  expect(within(menu).queryByRole("menuitem", { name: "Open worktree" })).toBeNull();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove selected worktrees" }));
  expect(screen.getByRole("dialog", { name: "Remove selected worktrees · 2" })).toBeDefined();
  expect(onOpen).not.toHaveBeenCalled();
});
