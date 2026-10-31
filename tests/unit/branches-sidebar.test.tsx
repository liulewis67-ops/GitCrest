// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BranchSnapshotResponse, RepositoryResponse } from "../../src/api/client";
import { BranchesSidebar } from "../../src/pages/workspace/BranchesSidebar";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";

afterEach(cleanup);

type Branch = BranchSnapshotResponse["branches"][number];

const repository: RepositoryResponse = { repoId: "repo", path: "C:/repo", head: "a".repeat(40), branch: "master", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };

function branch(name: string, kind: "local" | "remote", oid: string, extra: Partial<Branch> = {}): Branch {
  return { name, fullName: kind === "local" ? `refs/heads/${name}` : `refs/remotes/${name}`, oid: oid.repeat(40), kind, isCurrent: false, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null, ...extra };
}

const master = branch("master", "local", "a", { isCurrent: true });
const feature = branch("feature/x", "local", "b");
const elsewhere = branch("hotfix", "local", "c", { worktreePath: "D:/trees/hotfix" });
const bootbase = branch("origin/bootbase", "remote", "d");
const ordered = [master, feature, elsewhere, bootbase];

function renderSidebar(overrides: Partial<Parameters<typeof BranchesSidebar>[0]> = {}) {
  const handlers = {
    onSelectBranch: vi.fn(), onManageAccounts: vi.fn(), onRefreshBranches: vi.fn(), onOpenBranchSwitcher: vi.fn(), onDeleteRemoteBranch: vi.fn(),
    onSwitchBranch: vi.fn(), onCheckoutRemoteBranch: vi.fn(), onMergeBranch: vi.fn(), onRebaseOnto: vi.fn(), onCreateBranchFrom: vi.fn(),
    onCopyBranchName: vi.fn(), onOpenWorktree: vi.fn(), onNewWorktreeForBranch: vi.fn(), onNewWorktreeFrom: vi.fn(), onRemoveWorktree: vi.fn(), onWorktreePruneStarted: vi.fn(), onManageBranch: vi.fn(),
    onToggleBranchFavorite: vi.fn(), onRefreshRemotes: vi.fn(), onAddRemote: vi.fn(), onSetRemoteUrl: vi.fn(), onDeleteRemote: vi.fn(),
    onSetDefaultRemote: vi.fn(), onSetBranchUpstream: vi.fn(),
  };
  const props = {
    repository,
    branches: { repoId: "repo", current: "master", detached: false, branches: ordered },
    orderedBranches: ordered,
    branchesLoading: false,
    remotesLoading: false,
    remoteActionBusy: false,
    remoteDisabledReason: "",
    connected: true,
    hasActiveRepositoryTask: false,
    historyRefreshKey: 0,
    shortcuts: defaultShortcutPreferences,
    isMacPlatform: false,
    ...handlers,
    ...overrides,
  };
  const view = render(<BranchesSidebar {...props} />);
  return { handlers, rerender: (next: Partial<typeof props>) => view.rerender(<BranchesSidebar {...props} {...next} />) };
}

function openMenu(name: string) {
  fireEvent.contextMenu(screen.getByRole("button", { name: `Show history of ${name}` }), { clientX: 40, clientY: 60 });
  return screen.getByRole("menu", { name: `Actions for ${name}` });
}

function itemLabels(menu: HTMLElement) {
  return within(menu).getAllByRole("menuitem").map((item) => item.textContent);
}

it("selects a branch on click, marks it, and walks the list with the arrow keys", () => {
  const { handlers, rerender } = renderSidebar();
  fireEvent.click(screen.getByText("bootbase"));
  expect(handlers.onSelectBranch).toHaveBeenLastCalledWith(bootbase);

  rerender({ selectedBranch: feature.fullName });
  const selected = screen.getByRole("button", { name: "Show history of feature/x" });
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  expect(selected.closest("li")?.className).toContain("selected");
  expect(selected.tabIndex).toBe(0);
  expect(screen.getByRole("button", { name: "Show history of master" }).tabIndex).toBe(-1);

  selected.focus();
  fireEvent.keyDown(selected, { key: "ArrowDown" });
  expect(handlers.onSelectBranch).toHaveBeenLastCalledWith(elsewhere);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show history of hotfix" }));
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(handlers.onSelectBranch).toHaveBeenLastCalledWith(bootbase);

  // A row's own buttons keep their action and do not change the shown history.
  handlers.onSelectBranch.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Switch to feature/x" }));
  expect(handlers.onSwitchBranch).toHaveBeenCalledWith("feature/x");
  expect(handlers.onSelectBranch).not.toHaveBeenCalled();
});

it("offers checkout, new branch, merge, rebase, rename and delete for a local branch", () => {
  const { handlers } = renderSidebar();
  const menu = openMenu("feature/x");
  expect(itemLabels(menu)).toEqual([
    "Check out…", "New branch from here…", "Open in new worktree…", "Merge feature/x into current branch…",
    "Rebase current branch onto feature/x…", "Rename…", "Delete…", "Copy branch name",
  ]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Rebase current branch onto feature/x…" }));
  expect(handlers.onRebaseOnto).toHaveBeenCalledWith(feature.oid);
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.click(within(openMenu("feature/x")).getByRole("menuitem", { name: "Delete…" }));
  expect(handlers.onManageBranch).toHaveBeenCalledWith("feature/x", "delete");
  fireEvent.click(within(openMenu("feature/x")).getByRole("menuitem", { name: "Check out…" }));
  expect(handlers.onSwitchBranch).toHaveBeenCalledWith("feature/x");
  fireEvent.click(within(openMenu("feature/x")).getByRole("menuitem", { name: "New branch from here…" }));
  expect(handlers.onCreateBranchFrom).toHaveBeenCalledWith(feature.oid);
  fireEvent.click(within(openMenu("feature/x")).getByRole("menuitem", { name: "Copy branch name" }));
  expect(handlers.onCopyBranchName).toHaveBeenCalledWith("feature/x");
  expect(handlers.onSelectBranch).not.toHaveBeenCalled();
});

it("keeps the current branch's menu to what can be done to it, and a remote branch's to its own actions", () => {
  const { handlers } = renderSidebar();
  expect(itemLabels(openMenu("master"))).toEqual(["New branch from here…", "New worktree from master…", "Rename…", "Copy branch name"]);
  // The current branch cannot be checked out twice, so its worktree gets a new branch that starts at its tip.
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "New worktree from master…" }));
  expect(handlers.onNewWorktreeFrom).toHaveBeenCalledWith(master.oid, "master");
  openMenu("master");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

  const remote = openMenu("origin/bootbase");
  expect(itemLabels(remote)).toEqual([
    "Check out as local branch…", "New branch from here…", "Open in new worktree…", "Merge origin/bootbase into current branch…",
    "Rebase current branch onto origin/bootbase…", "Delete from remote…", "Copy branch name",
  ]);
  fireEvent.click(within(remote).getByRole("menuitem", { name: "Check out as local branch…" }));
  expect(handlers.onCheckoutRemoteBranch).toHaveBeenCalledWith("origin/bootbase");
  fireEvent.click(within(openMenu("origin/bootbase")).getByRole("menuitem", { name: "Open in new worktree…" }));
  expect(handlers.onNewWorktreeForBranch).toHaveBeenCalledWith("origin/bootbase", true);
  fireEvent.click(within(openMenu("origin/bootbase")).getByRole("menuitem", { name: "Delete from remote…" }));
  expect(handlers.onDeleteRemoteBranch).toHaveBeenCalledWith("refs/remotes/origin/bootbase");
});

it("opens or removes the worktree of a branch checked out elsewhere and will not delete the branch", () => {
  const { handlers } = renderSidebar();
  const menu = openMenu("hotfix");
  expect(itemLabels(menu)[0]).toBe("Open its worktree");
  expect(itemLabels(menu)).not.toContain("Open in new worktree…");
  expect(itemLabels(menu)).toContain("New worktree from hotfix…");
  expect((within(menu).getByRole("menuitem", { name: "Delete…" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Open its worktree" }));
  expect(handlers.onOpenWorktree).toHaveBeenCalledWith("D:/trees/hotfix");
  fireEvent.click(within(openMenu("hotfix")).getByRole("menuitem", { name: "Remove its worktree…" }));
  expect(handlers.onRemoveWorktree).toHaveBeenCalledWith("D:/trees/hotfix");
});

it("disables changing actions while a repository task runs but still copies the name", () => {
  renderSidebar({ hasActiveRepositoryTask: true });
  const menu = openMenu("feature/x");
  const disabled = within(menu).getAllByRole("menuitem").filter((item) => (item as HTMLButtonElement).disabled).map((item) => item.textContent);
  expect(disabled).toEqual([
    "Check out…", "New branch from here…", "Open in new worktree…", "Merge feature/x into current branch…",
    "Rebase current branch onto feature/x…", "Rename…", "Delete…",
  ]);
});

it("offers Compare with… on local and remote branches, also while a Git task runs", () => {
  const onCompareRef = vi.fn();
  renderSidebar({ onCompareRef, hasActiveRepositoryTask: true });
  for (const [name, expected] of [["feature/x", "feature/x"], ["origin/bootbase", "origin/bootbase"]] as const) {
    const item = within(openMenu(name)).getByRole("menuitem", { name: "Compare with…" }) as HTMLButtonElement;
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    expect(onCompareRef).toHaveBeenLastCalledWith(expected);
  }
});

it("leaves Compare with… out when nothing handles it", () => {
  renderSidebar();
  expect(within(openMenu("feature/x")).queryByRole("menuitem", { name: "Compare with…" })).toBeNull();
});
