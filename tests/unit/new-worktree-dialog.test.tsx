// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { NewWorktreeDialog } from "../../src/features/branches/ui/NewWorktreeDialog";

afterEach(() => { cleanup(); window.localStorage.clear(); });

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
  expect(addRepositoryWorktree).toHaveBeenCalledWith("repo_x", "feature/login", "D:/trees/app-feature-login", false);
});

it("shows the engine's reason when the branch is already checked out elsewhere", async () => {
  const { GitCrestApiError } = await import("../../src/api/client");
  const failure = new GitCrestApiError(409, { error: { code: "REQUEST_INVALID", message: "That branch is already checked out in another worktree." } } as never);
  const api = { addRepositoryWorktree: vi.fn().mockRejectedValue(failure) } as unknown as GitCrestApiClient;
  render(<NewWorktreeDialog api={api} repoId="repo_x" repositoryPath="C:/work/app" branch="main" disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
  expect((await screen.findByRole("alert")).textContent).toContain("already checked out in another worktree");
});

it("creates a local tracking branch in the worktree when opening a remote branch", async () => {
  const addRepositoryWorktree = vi.fn().mockResolvedValue({ taskId: "t3" });
  const api = { addRepositoryWorktree } as unknown as GitCrestApiClient;
  render(<NewWorktreeDialog api={api} repoId="repo_x" repositoryPath="C:/work/app" branch="origin/feature/login" fromRemote disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);

  expect(screen.getByText("REMOTE BRANCH")).toBeTruthy();
  expect(screen.getByText(/A local branch named/).textContent).toContain("feature/login");
  expect((screen.getByRole("textbox", { name: "Worktree folder" }) as HTMLInputElement).value).toBe("C:/work/app-feature-login");
  fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
  await waitFor(() => expect(addRepositoryWorktree).toHaveBeenCalledWith("repo_x", "origin/feature/login", "C:/work/app-feature-login", true));
});

it("remembers the folder it was created in and suggests it next time", async () => {
  const api = { addRepositoryWorktree: vi.fn().mockResolvedValue({ taskId: "t4" }) } as unknown as GitCrestApiClient;
  const first = render(<NewWorktreeDialog api={api} repoId="repo_x" repositoryPath="C:/work/app" branch="one" disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Worktree folder" }), { target: { value: "E:/scratch/trees/app-one" } });
  fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
  await waitFor(() => expect(window.localStorage.getItem("gitcrest.worktreeParent")).toBe("E:/scratch/trees"));
  first.unmount();
  render(<NewWorktreeDialog api={api} repoId="repo_x" repositoryPath="C:/work/app" branch="two" disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);
  expect((screen.getByRole("textbox", { name: "Worktree folder" }) as HTMLInputElement).value).toBe("E:/scratch/trees/app-two");
});
