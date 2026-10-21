// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloneDialog } from "../../src/features/cloning/ui/CloneDialog";

afterEach(cleanup);

it("focuses the remote URL field when opened and closes with Escape", async () => {
  const onClose = vi.fn();
  render(<CloneDialog parentPath="C:/repositories" error="" busy={false} onManageAccounts={vi.fn()} onChooseParent={vi.fn()} onClose={onClose} onSubmit={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Clone repository" });
  const remoteUrl = screen.getByRole("textbox", { name: "Remote URL" });
  await waitFor(() => expect(document.activeElement).toBe(remoteUrl));

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});

it("hands sign-in to Settings with the typed draft and the remote's HTTPS host", () => {
  const onManageAccounts = vi.fn();
  render(<CloneDialog initialRemoteUrl="https://Example.test:443/org/repo.git" parentPath="C:/repositories" error="" busy={false} onManageAccounts={onManageAccounts} onChooseParent={vi.fn()} onClose={vi.fn()} onSubmit={vi.fn()} />);
  expect(screen.queryByLabelText("Token or password")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Manage accounts" }));
  expect(onManageAccounts).toHaveBeenCalledWith({ remoteUrl: "https://Example.test:443/org/repo.git", parentPath: "C:/repositories", directoryName: "repo" }, ["example.test"]);
});
