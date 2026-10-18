// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { NewWorktreeDialog } from "../../src/features/branches/ui/NewWorktreeDialog";

afterEach(cleanup);

it("suggests a sibling folder, lets the user browse, and creates the worktree for the branch", async () => {
  const addRepositoryWorktree = vi.fn().mockResolvedValue({ taskId: "t1" });
  const onStarted = vi.fn();
  const api = { addRepositoryWorktree } as unknown as GitCrestApiClient;
  render(<NewWorktreeDialog api={api} repoId="repo_x" repositoryPath="C:/work/app" branch="feature/login" disabled={false} onChooseFolder={vi.fn().mockResolvedValue("D:/trees")} onClose={vi.fn()} onStarted={onStarted} />);

  const folder = screen.getByRole("textbox", { name: "Worktree folder" }) as HTMLInputElement;
  expect(folder.value).toBe("C:/work/app-feature-login");
  fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
  await waitFor(() => expect(folder.value).toBe("D:/trees/app-feature-login"));
  fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ taskId: "t1" }));
  expect(addRepositoryWorktree).toHaveBeenCalledWith("repo_x", "feature/login", "D:/trees/app-feature-login");
});

it("shows the engine's reason when the branch is already checked out elsewhere", async () => {
  const { GitCrestApiError } = await import("../../src/api/client");
  const failure = new GitCrestApiError(409, { error: { code: "REQUEST_INVALID", message: "That branch is already checked out in another worktree." } } as never);
  const api = { addRepositoryWorktree: vi.fn().mockRejectedValue(failure) } as unknown as GitCrestApiClient;
  render(<NewWorktreeDialog api={api} repoId="repo_x" repositoryPath="C:/work/app" branch="main" disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
  expect((await screen.findByRole("alert")).textContent).toContain("already checked out in another worktree");
});
