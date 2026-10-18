// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { LocalFilesPicker } from "../../src/features/branches/ui/LocalFilesPicker";
import { NewWorktreeDialog } from "../../src/features/branches/ui/NewWorktreeDialog";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function fakeApi(overrides: Record<string, unknown>) {
  const api = { withSignal: () => api, ...overrides };
  return api as unknown as GitCrestApiClient;
}

const listing = { files: [{ path: ".env", sizeBytes: 120 }, { path: "config/local.json", sizeBytes: 4096 }], omittedCount: 2 };

function Harness({ api }: { api: GitCrestApiClient }) {
  const [selected, setSelected] = useState<string[]>([]);
  return <><LocalFilesPicker api={api} repoId="repo_x" selected={selected} onChange={setSelected} /><output aria-label="selected">{selected.join(",")}</output></>;
}

it("lists ignored files with nothing selected by default and reports what the user ticks", async () => {
  render(<Harness api={fakeApi({ listWorktreeLocalFiles: vi.fn().mockResolvedValue(listing) })} />);
  expect(await screen.findByText("Copy local files (ignored by Git)")).toBeTruthy();
  const env = screen.getByRole("checkbox", { name: /\.env/ }) as HTMLInputElement;
  expect(env.checked).toBe(false);
  expect(screen.getByText(/2 larger or folder item\(s\) are not offered/)).toBeTruthy();
  fireEvent.click(env);
  fireEvent.click(screen.getByRole("checkbox", { name: /config\/local\.json/ }));
  expect(screen.getByLabelText("selected").textContent).toBe(".env,config/local.json");
  fireEvent.click(env);
  expect(screen.getByLabelText("selected").textContent).toBe("config/local.json");
});

it("renders nothing when there are no files or the listing is unavailable", async () => {
  const empty = render(<Harness api={fakeApi({ listWorktreeLocalFiles: vi.fn().mockResolvedValue({ files: [], omittedCount: 0 }) })} />);
  await waitFor(() => expect(empty.container.querySelector("fieldset")).toBeNull());
  empty.unmount();
  const broken = render(<Harness api={fakeApi({ listWorktreeLocalFiles: vi.fn().mockRejectedValue(new Error("offline")) })} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(broken.container.querySelector("fieldset")).toBeNull();
});

it("sends only the ticked files when creating the worktree", async () => {
  const addRepositoryWorktree = vi.fn().mockResolvedValue({ taskId: "t9" });
  const api = fakeApi({ listWorktreeLocalFiles: vi.fn().mockResolvedValue(listing), addRepositoryWorktree });
  render(<NewWorktreeDialog api={api} repoId="repo_x" repositoryPath="C:/work/app" branch="feature/x" disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /\.env/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
  await waitFor(() => expect(addRepositoryWorktree).toHaveBeenCalledWith("repo_x", "feature/x", "C:/work/app-feature-x", false, [".env"]));
});
