// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { LocalBranchDialog } from "../../src/features/branches/ui/LocalBranchDialog";

afterEach(cleanup);

function fakeApi(overrides: Record<string, unknown>) {
  const api = { withSignal: () => api, ...overrides };
  return api as unknown as GitCrestApiClient;
}

it("requires confirmation before deleting a branch with unmerged commits", async () => {
  const deleteRepositoryBranch = vi.fn().mockResolvedValue({ taskId: "t1" });
  const onStarted = vi.fn();
  const api = fakeApi({
    previewRepositoryBranchDelete: vi.fn().mockResolvedValue({ name: "feature", isCurrent: false, unmergedCommitCount: 2, requiresConfirmation: true }),
    deleteRepositoryBranch,
  });
  render(<LocalBranchDialog api={api} repoId="repo_x" action={{ name: "feature", mode: "delete" }} disabled={false} onClose={vi.fn()} onStarted={onStarted} />);

  const confirm = await screen.findByRole("checkbox");
  const remove = screen.getByRole("button", { name: "Delete branch" }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(remove.disabled).toBe(false);
  fireEvent.click(remove);
  await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith({ taskId: "t1" }));
  expect(deleteRepositoryBranch).toHaveBeenCalledWith("repo_x", "feature", true);
});

it("blocks deleting the current branch and renames only to a different name", async () => {
  const renameRepositoryBranch = vi.fn().mockResolvedValue({ taskId: "t2" });
  const current = fakeApi({ previewRepositoryBranchDelete: vi.fn().mockResolvedValue({ name: "main", isCurrent: true, unmergedCommitCount: 0, requiresConfirmation: false }) });
  const view = render(<LocalBranchDialog api={current} repoId="repo_x" action={{ name: "main", mode: "delete" }} disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);
  expect(await screen.findByText(/current branch cannot be deleted/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Delete branch" }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();

  render(<LocalBranchDialog api={fakeApi({ renameRepositoryBranch })} repoId="repo_x" action={{ name: "old", mode: "rename" }} disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);
  const rename = screen.getByRole("button", { name: "Rename branch" }) as HTMLButtonElement;
  expect(rename.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "New name" }), { target: { value: " new " } });
  expect(rename.disabled).toBe(false);
  fireEvent.click(rename);
  await vi.waitFor(() => expect(renameRepositoryBranch).toHaveBeenCalledWith("repo_x", "old", "new"));
});
