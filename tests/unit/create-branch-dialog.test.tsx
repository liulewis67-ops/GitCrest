// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { CreateBranchDialog } from "../../src/features/branches/ui/CreateBranchDialog";

afterEach(cleanup);

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
  fireEvent.click(screen.getByRole("checkbox", { name: "Switch to the new branch" }));
  fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ taskId: "t1" }));
  expect(createRepositoryBranch).toHaveBeenCalledWith("repo_x", "hotfix/from-here", { checkout: false, startPoint: start });
});
