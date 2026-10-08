// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloneDialog } from "../../src/features/cloning/CloneDialog";

afterEach(cleanup);

it("focuses the remote URL field when opened and closes with Escape", async () => {
  const onClose = vi.fn();
  render(<CloneDialog parentPath="C:/repositories" error="" busy={false} onChooseParent={vi.fn()} onClose={onClose} onSubmit={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Clone repository" });
  const remoteUrl = screen.getByRole("textbox", { name: "Remote URL" });
  await waitFor(() => expect(document.activeElement).toBe(remoteUrl));

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});
