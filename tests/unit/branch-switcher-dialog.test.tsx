// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BranchSnapshotResponse, RepositoryResponse } from "../../src/api/client";
import { BranchSwitcherDialog } from "../../src/features/branches/ui/BranchSwitcherDialog";

afterEach(cleanup);

const repository: RepositoryResponse = { repoId: "repo_x", path: "C:/work/repo", head: "a".repeat(40), branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
const branch = (name: string, isCurrent = false): BranchSnapshotResponse["branches"][number] => ({
  name, fullName: `refs/heads/${name}`, oid: "b".repeat(40), kind: "local", isCurrent, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null,
});

function renderDialog(onOpenWorktree?: (path: string) => void, extra: BranchSnapshotResponse["branches"] = [], overrides: Partial<Parameters<typeof BranchSwitcherDialog>[0]> = {}) {
  const inspect = vi.fn();
  const createBranch = vi.fn();
  const branchSwitcher = {
    open: true, setOpen: vi.fn(), targetName: "", preflight: undefined, error: "", setError: vi.fn(), busy: false,
    openSwitcher: vi.fn(), close: vi.fn(), chooseAnother: vi.fn(), inspect, continueSwitch: vi.fn(), createBranch, reviewAfterShelf: vi.fn(), runWhileBusy: vi.fn(),
  } as unknown as Parameters<typeof BranchSwitcherDialog>[0]["branchSwitcher"];
  render(<BranchSwitcherDialog
    repository={repository}
    branchSwitcher={branchSwitcher}
    branches={[{ ...branch("main", true), upstream: "origin/main" }, branch("feature/alpha"), branch("feature/beta"), branch("release"), ...extra]}
    hasBranchSnapshot
    branchesLoading={false}
    connected
    hasActiveRepositoryTask={false}
    branchSwitcherShortcut="Ctrl+B"
    shelveShortcut="Ctrl+Shift+S"
    shelveAriaShortcut="Control+Shift+S"
    onCommitChanges={vi.fn()}
    onShelveAndSwitch={vi.fn()}
    onOpenWorktree={onOpenWorktree}
    {...overrides}
  />);
  return { inspect, createBranch, filter: screen.getByRole("searchbox", { name: "Filter branches" }) };
}

it("moves through the filtered branches with the arrow keys and switches to the highlighted one", () => {
  const { inspect, filter } = renderDialog();
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(inspect).toHaveBeenLastCalledWith("release");
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(inspect).toHaveBeenLastCalledWith("feature/alpha");
  fireEvent.keyDown(filter, { key: "ArrowUp" });
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(inspect).toHaveBeenLastCalledWith("release");
});

function managedActions() {
  return {
    onSwitchBranch: vi.fn(), onCheckoutRemoteBranch: vi.fn(), onCreateBranchFrom: vi.fn(), onNewWorktreeFrom: vi.fn(), onNewWorktreeForBranch: vi.fn(),
    onMergeBranch: vi.fn(), onRebaseOnto: vi.fn(), onManageBranch: vi.fn(), onRemoveWorktree: vi.fn(), onDeleteRemoteBranch: vi.fn(), onCompareRef: vi.fn(),
    onCopyBranchName: vi.fn(), onOpenWorktree: vi.fn(), onShowHistory: vi.fn(), onToggleFavorite: vi.fn(), onPush: vi.fn(), onPull: vi.fn(),
  };
}

it("offers Fetch all, current and tracked branches, and History's remote context actions", () => {
  const actions = managedActions();
  const fetchAll = vi.fn();
  renderDialog(undefined, [remote("origin/main")], { actions, onFetchAllRemotes: fetchAll, remoteCount: 1 });
  fireEvent.click(screen.getByRole("button", { name: "Fetch all remotes" }));
  expect(fetchAll).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "main" })).toBeDefined();
  const row = screen.getByRole("button", { name: /^origin\/main updates main/ }).closest(".branchPickerRow")!;
  fireEvent.contextMenu(row, { clientX: 80, clientY: 100 });
  const menu = screen.getByRole("menu", { name: "Actions for origin/main" });
  for (const name of ["Check out as local branch…", "New branch from here…", "Open in new worktree…", "Merge origin/main into current branch…", "Rebase current branch onto origin/main…", "Delete from remote…", "Compare with…", "Copy branch name"]) {
    expect(within(menu).getByRole("menuitem", { name })).toBeDefined();
  }
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Check out as local branch…" }));
  expect(actions.onCheckoutRemoteBranch).toHaveBeenCalledWith("origin/main");
});

it("opens the shared local menu with the keyboard and keeps Escape inside the picker", () => {
  const actions = managedActions();
  renderDialog(undefined, [], { actions });
  const row = screen.getByRole("button", { name: "feature/alpha" });
  row.focus();
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(document.activeElement).toBe(row);
  expect(screen.getByRole("dialog", { name: "Switch branch" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "More actions for feature/alpha" }));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Rename…" }));
  expect(actions.onManageBranch).toHaveBeenCalledWith("feature/alpha", "rename");
  fireEvent.click(screen.getByRole("button", { name: "More actions for main" }));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Pull" }));
  expect(actions.onPull).toHaveBeenCalledOnce();
});

it("disables mutations while a task runs but retains copy and history", () => {
  renderDialog(undefined, [], { actions: managedActions(), hasActiveRepositoryTask: true, onFetchAllRemotes: vi.fn() });
  expect((screen.getByRole("button", { name: "Fetch all remotes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "More actions for feature/alpha" }));
  const menu = screen.getByRole("menu");
  expect((within(menu).getByRole("menuitem", { name: "Merge feature/alpha into current branch…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(menu).getByRole("menuitem", { name: "Copy branch name" }) as HTMLButtonElement).disabled).toBe(false);
});

it("resets the highlight when the filter changes and creates a branch when nothing matches", () => {
  const { inspect, createBranch, filter } = renderDialog();
  fireEvent.keyDown(filter, { key: "ArrowDown" });
  fireEvent.change(filter, { target: { value: "feature" } });
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(inspect).toHaveBeenLastCalledWith("feature/alpha");
  fireEvent.change(filter, { target: { value: "brand-new" } });
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(createBranch).toHaveBeenCalledWith("brand-new", { checkout: true });
  expect(screen.getByRole("button", { name: /Create and switch to/ })).toBeTruthy();
});

it("offers to open the worktree instead of switching to a branch another worktree has checked out", () => {
  const onOpenWorktree = vi.fn();
  renderDialog(onOpenWorktree, [{ ...branch("hotfix"), worktreePath: "D:/trees/hotfix" }]);
  expect(screen.getByText("open in another worktree")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open worktree" }));
  expect(onOpenWorktree).toHaveBeenCalledWith("D:/trees/hotfix");
  expect(screen.queryByRole("button", { name: /hotfix/ })).toBeNull();
});

it("flags a non-empty worktree folder for a new branch before anything is submitted", async () => {
  const checkWorktreeFolder = vi.fn().mockResolvedValue({ status: "notEmpty" });
  const api = { withSignal: () => api, checkWorktreeFolder } as unknown as import("../../src/api/client").GitCrestApiClient;
  const branchSwitcher = {
    open: true, setOpen: vi.fn(), targetName: "", preflight: undefined, error: "", setError: vi.fn(), busy: false,
    openSwitcher: vi.fn(), close: vi.fn(), chooseAnother: vi.fn(), inspect: vi.fn(), continueSwitch: vi.fn(), createBranch: vi.fn(), reviewAfterShelf: vi.fn(), runWhileBusy: vi.fn(),
  } as unknown as Parameters<typeof BranchSwitcherDialog>[0]["branchSwitcher"];
  render(<BranchSwitcherDialog repository={repository} branchSwitcher={branchSwitcher} branches={[branch("main", true)]} hasBranchSnapshot branchesLoading={false} connected hasActiveRepositoryTask={false} branchSwitcherShortcut="Ctrl+B" shelveShortcut="Ctrl+Shift+S" shelveAriaShortcut="Control+Shift+S" onCommitChanges={vi.fn()} onShelveAndSwitch={vi.fn()} api={api} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter branches" }), { target: { value: "brand-new" } });
  expect((await screen.findByRole("alert", {}, { timeout: 2000 })).textContent).toContain("already contains files");
  expect((screen.getByRole("button", { name: /in a new worktree/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(checkWorktreeFolder).toHaveBeenCalledWith("repo_x", "C:/work/repo-brand-new");
});

it("creates the typed branch in a new worktree with Shift+Enter, but only when a new name is typed", () => {
  const { createBranch, filter } = renderDialog();
  fireEvent.keyDown(filter, { key: "Enter", shiftKey: true });
  expect(createBranch).not.toHaveBeenCalled();
  fireEvent.change(filter, { target: { value: "release" } });
  fireEvent.keyDown(filter, { key: "Enter", shiftKey: true });
  expect(createBranch).not.toHaveBeenCalled();
  fireEvent.change(filter, { target: { value: "brand-new" } });
  fireEvent.keyDown(filter, { key: "Enter", shiftKey: true });
  expect(createBranch).toHaveBeenCalledWith("brand-new", { worktreePath: "C:/work/repo-brand-new" });
});

const remote = (name: string): BranchSnapshotResponse["branches"][number] => ({
  name, fullName: `refs/remotes/${name}`, oid: "c".repeat(40), kind: "remote", isCurrent: false, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null,
});

it("lists remote branches after the local ones and inspects them as remote targets", () => {
  const { inspect, filter } = renderDialog(undefined, [
    { ...branch("feature/beta"), name: "feature/tracked", fullName: "refs/heads/feature/tracked", upstream: "origin/feature/tracked" },
    remote("origin/HEAD"),
    remote("origin/main"),
    remote("origin/feature/tracked"),
    remote("origin/feature/fresh"),
  ]);
  expect(screen.getByRole("heading", { name: "Remote branches" })).toBeTruthy();
  // The current branch's own upstream and the symbolic origin/HEAD are not switch targets.
  expect(screen.queryByRole("button", { name: /origin\/main/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /origin\/HEAD/ })).toBeNull();
  expect(screen.getByRole("button", { name: /origin\/feature\/tracked.*updates feature\/tracked/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /origin\/feature\/fresh.*new local branch/ }));
  expect(inspect).toHaveBeenLastCalledWith("origin/feature/fresh", true);

  fireEvent.change(filter, { target: { value: "fresh" } });
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(inspect).toHaveBeenLastCalledWith("origin/feature/fresh", true);
});
