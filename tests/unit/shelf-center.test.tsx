// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ShelfResponse } from "../../src/api/client";
import { ShelfCenter } from "../../src/features/shelves/ui/ShelfCenter";

afterEach(cleanup);

function renderShelfCenter(shelves: ShelfResponse[] = []) {
  const api = { listRepositoryShelves: vi.fn().mockResolvedValue(shelves) } as unknown as import("../../src/api/client").GitCrestApiClient;
  render(<ShelfCenter api={api} repoId="repo_fixture" headOid={"a".repeat(40)} files={[]} statusReady disabled={false} refreshKey={0} openComposerRequest={0} onTaskSubmitted={vi.fn()} />);
  return api;
}

it("moves focus into the shelf composer and closes it with Escape", async () => {
  renderShelfCenter();
  await screen.findByText(/No saved shelves/);
  fireEvent.click(screen.getByRole("button", { name: /Shelve selected changes/ }));
  const dialog = screen.getByRole("dialog", { name: "Shelve selected changes" });
  const name = screen.getByRole("textbox", { name: "Name" });
  await waitFor(() => expect(document.activeElement).toBe(name));

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Shelve selected changes" })).toBeNull();
});

it("opens the composer with a file chosen from the file tree already selected and named", async () => {
  const files = [
    { path: "src/staged.ts", indexStatus: "M", worktreeStatus: ".", kind: "modified", categories: ["staged"], modeChanged: false },
    { path: "src/other.ts", indexStatus: "M", worktreeStatus: ".", kind: "modified", categories: ["staged"], modeChanged: false },
  ] as import("../../src/api/client").StatusSnapshotResponse["files"];
  const diff = { repoId: "repo_fixture", path: "src/staged.ts", scope: "index", status: "text", revision: "rev-1", changeKind: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, rows: [] }] };
  const api = {
    listRepositoryShelves: vi.fn().mockResolvedValue([]),
    getFileDiff: vi.fn().mockResolvedValue(diff),
  } as unknown as import("../../src/api/client").GitCrestApiClient;
  render(<ShelfCenter api={api} repoId="repo_fixture" headOid={"a".repeat(40)} files={files} statusReady disabled={false} refreshKey={0} openComposerRequest={1} composerPreselect={{ paths: ["src/staged.ts"], scope: "index" }} onTaskSubmitted={vi.fn()} />);

  await screen.findByRole("dialog", { name: "Shelve selected changes" });
  expect(api.getFileDiff).toHaveBeenCalledWith("repo_fixture", "src/staged.ts", "index");
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("staged.ts");
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("index");
  await waitFor(() => expect((screen.getByRole("checkbox", { name: /src\/staged\.ts/ }) as HTMLInputElement).checked).toBe(true));
  expect((screen.getByRole("checkbox", { name: /src\/other\.ts/ }) as HTMLInputElement).checked).toBe(false);
});

it("puts the safe action first in shelf deletion confirmation", async () => {
  renderShelfCenter([{
    shelfId: "shelf_fixture", repoId: "repo_fixture", name: "draft", description: "",
    paths: ["src/file.ts"], scope: "workingTree", headOid: "a".repeat(40), createdAtMs: 1,
  }]);
  fireEvent.click(await screen.findByRole("button", { name: "Review deletion of draft" }));
  const dialog = screen.getByRole("alertdialog", { name: "Delete “draft”?" });
  const keep = screen.getByRole("button", { name: "Keep shelf" });
  await waitFor(() => expect(document.activeElement).toBe(keep));

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("alertdialog", { name: "Delete “draft”?" })).toBeNull();
});
