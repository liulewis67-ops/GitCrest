// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { CreateBranchDialog } from "../../src/features/branches/ui/CreateBranchDialog";

afterEach(() => { cleanup(); window.localStorage.clear(); });

it("creates a branch at the chosen commit and switches to it by default", async () => {
  const createRepositoryBranch = vi.fn().mockResolvedValue({ taskId: "t1" });
  const onStarted = vi.fn();
  const api = { createRepositoryBranch } as unknown as GitCrestApiClient;
  const start = "c".repeat(40);
  render(<CreateBranchDialog api={api} repoId="repo_x" startOid={start} disabled={false} onClose={vi.fn()} onStarted={onStarted} />);

  const create = screen.getByRole("button", { name: "Create and switch" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Branch name" }), { target: { value: " hotfix/from-here " } });
  expect(create.disabled).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: "Stay on the current branch" }));
  fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ taskId: "t1" }));
  expect(createRepositoryBranch).toHaveBeenCalledWith("repo_x", "hotfix/from-here", { checkout: false, startPoint: start });
});

it("offers a worktree folder suggestion, lets the user browse, and sends the worktree path", async () => {
  const createRepositoryBranch = vi.fn().mockResolvedValue({ taskId: "t2" });
  const onStarted = vi.fn();
  const api = { createRepositoryBranch } as unknown as GitCrestApiClient;
  const onChooseFolder = vi.fn().mockResolvedValue("D:/trees/");
  render(<CreateBranchDialog api={api} repoId="repo_x" repositoryPath="C:/work/app" startOid={"d".repeat(40)} disabled={false} onChooseFolder={onChooseFolder} onClose={vi.fn()} onStarted={onStarted} />);

  fireEvent.change(screen.getByRole("textbox", { name: "Branch name" }), { target: { value: "feature/x" } });
  fireEvent.click(screen.getByRole("radio", { name: "Check it out in a new worktree" }));
  expect((screen.getByRole("textbox", { name: "Worktree folder" }) as HTMLInputElement).value).toBe("C:/work/app-feature-x");
  fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Worktree folder" }) as HTMLInputElement).value).toBe("D:/trees/app-feature-x"));
  fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ taskId: "t2" }));
  expect(createRepositoryBranch).toHaveBeenCalledWith("repo_x", "feature/x", { checkout: false, startPoint: "d".repeat(40), worktreePath: "D:/trees/app-feature-x", copyFiles: [] });
});
