// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloneDialog } from "../../src/features/cloning/ui/CloneDialog";

afterEach(cleanup);

it("focuses the remote URL field when opened and closes with Escape", async () => {
  const onClose = vi.fn();
  render(<CloneDialog parentPath="C:/repositories" error="" busy={false} renderCredentialEditor={() => null} onChooseParent={vi.fn()} onClose={onClose} onSubmit={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Clone repository" });
  const remoteUrl = screen.getByRole("textbox", { name: "Remote URL" });
  await waitFor(() => expect(document.activeElement).toBe(remoteUrl));

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});

it("delegates HTTPS credential UI to the app composition layer", () => {
  const renderCredentialEditor = vi.fn(() => null);
  render(<CloneDialog initialRemoteUrl="https://Example.test:443/org/repo.git" parentPath="C:/repositories" error="" busy renderCredentialEditor={renderCredentialEditor} onChooseParent={vi.fn()} onClose={vi.fn()} onSubmit={vi.fn()} />);

  expect(renderCredentialEditor).toHaveBeenCalledWith("example.test", true);
});
