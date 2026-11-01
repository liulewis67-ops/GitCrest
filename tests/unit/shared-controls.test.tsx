// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "../../src/shared/ui/Button";
import { Dialog, DialogFooter, DialogHeader } from "../../src/shared/ui/Dialog";

afterEach(cleanup);

it("focuses the requested field, traps Tab, closes with Escape and restores the opener", async () => {
  const opener = document.createElement("button");
  document.body.append(opener); opener.focus();
  const onClose = vi.fn();
  const { unmount } = render(<Dialog onClose={onClose} aria-labelledby="test-title"><DialogHeader><h2 id="test-title">Create branch</h2></DialogHeader><input aria-label="Branch name" data-dialog-initial-focus /><DialogFooter><Button>Cancel</Button><Button variant="primary">Create</Button></DialogFooter></Dialog>);
  const field = screen.getByRole("textbox", { name: "Branch name" });
  await waitFor(() => expect(document.activeElement).toBe(field));
  screen.getByRole("button", { name: "Create" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  fireEvent.keyDown(field, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  unmount(); expect(document.activeElement).toBe(opener); opener.remove();
});

it("blocks dismissal while busy and keeps destructive actions as buttons", () => {
  const onClose = vi.fn();
  const { container } = render(<Dialog busy onClose={onClose} aria-labelledby="delete-title"><DialogHeader><h2 id="delete-title">Delete branch</h2></DialogHeader><DialogFooter><Button>Cancel</Button><Button variant="danger" disabled>Delete</Button></DialogFooter></Dialog>);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.mouseDown(container.querySelector(".sharedDialogBackdrop")!);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Delete" }).className).toContain("gcButton-danger");
});

it("makes Settings siblings inert, including new background content, and restores their prior state", async () => {
  const { container, rerender } = render(<main><button>Workspace action</button><Dialog fullPage onClose={vi.fn()} aria-labelledby="settings-title"><DialogHeader><h2 id="settings-title">Settings</h2></DialogHeader></Dialog></main>);
  const background = screen.getByRole("button", { name: "Workspace action" });
  expect(background.inert).toBe(true);
  expect(container.querySelector(".sharedDialogFullPage")?.hasAttribute("inert")).toBe(false);
  const lateAction = document.createElement("button");
  background.parentElement!.append(lateAction);
  await waitFor(() => expect(lateAction.inert).toBe(true));
  rerender(<main><button>Workspace action</button></main>);
  expect(background.inert).toBeFalsy();
  expect(lateAction.inert).toBeFalsy();
});
