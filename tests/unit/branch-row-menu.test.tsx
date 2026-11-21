// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BranchRowMenu } from "../../src/features/branches/ui/BranchRowMenu";

afterEach(cleanup);

it("keeps an open menu usable when the row's hover actions disappear during reordering", () => {
  const handlers = { onNewWorktree: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
  const view = render(<span><BranchRowMenu branch="feature/x" disabled={false} {...handlers} /></span>);
  fireEvent.click(screen.getByRole("button", { name: "More actions for feature/x" }));
  view.rerender(<span style={{ display: "none" }}><BranchRowMenu branch="feature/x" disabled={false} {...handlers} /></span>);
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename feature/x" }));
  expect(handlers.onRename).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
});

function renderMenu(disabled = false) {
  const handlers = { onNewWorktree: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
  render(<BranchRowMenu branch="feature/x" disabled={disabled} {...handlers} />);
  return handlers;
}

it("opens a menu with readable labels and runs the chosen action, then closes", () => {
  const handlers = renderMenu();
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More actions for feature/x" }));
  expect(screen.getByRole("menu", { name: "Actions for feature/x" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Open feature/x in a new worktree" }).textContent).toBe("Open in new worktree…");
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename feature/x" }));
  expect(handlers.onRename).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "More actions for feature/x" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete feature/x" }));
  expect(handlers.onDelete).toHaveBeenCalledTimes(1);
});

it("closes on Escape and on an outside click, and is unavailable while disabled", () => {
  renderMenu();
  const more = screen.getByRole("button", { name: "More actions for feature/x" });
  fireEvent.click(more);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(more);
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  cleanup();
  renderMenu(true);
  expect((screen.getByRole("button", { name: "More actions for feature/x" }) as HTMLButtonElement).disabled).toBe(true);
});

it("disables creating a second worktree and deleting a branch that another worktree has checked out", () => {
  const handlers = { onNewWorktree: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
  render(<BranchRowMenu branch="feature/x" disabled={false} checkedOutAt="D:/trees/x" {...handlers} />);
  fireEvent.click(screen.getByRole("button", { name: "More actions for feature/x" }));
  const worktree = screen.getByRole("menuitem", { name: "Open feature/x in a new worktree" }) as HTMLButtonElement;
  expect(worktree.disabled).toBe(true);
  expect(worktree.title).toContain("D:/trees/x");
  expect((screen.getByRole("menuitem", { name: "Delete feature/x" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("menuitem", { name: "Rename feature/x" }) as HTMLButtonElement).disabled).toBe(false);
});
