// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { PullDialog } from "../../src/features/remotes/ui/PullDialog";

afterEach(cleanup);

const preview: components["schemas"]["PullPreflight"] = {
  repoId: "repo_fixture",
  localBranch: "feature/change",
  remoteName: "origin",
  remoteBranch: "feature/change",
  localOid: "a".repeat(40),
  trackingOid: "b".repeat(40),
  ahead: 1,
  behind: 2,
  isClean: true,
  mergeRequiresPreservation: false,
  dirtyPaths: [],
  omittedDirtyPathCount: 0,
  hasConflicts: false,
  operationInProgress: false,
};

it("shows the upstream and requires an explicit merge or rebase selection", () => {
  const onPull = vi.fn();
  render(<PullDialog snapshot={preview} loading={false} busy={false} error="" disabled={false} disabledReason="" onRefresh={vi.fn()} onPull={onPull} onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Pull current branch" });
  expect(within(dialog).getByText("origin/feature/change")).toBeTruthy();
  expect(within(dialog).getByLabelText(/Merge/)).toBeTruthy();
  fireEvent.click(within(dialog).getByLabelText(/Rebase/));
  fireEvent.click(within(dialog).getByRole("button", { name: "Pull with rebase" }));
  expect(onPull).toHaveBeenCalledWith("rebase");
});

it("lists unresolved conflicts and blocks starting another pull", () => {
  const onPull = vi.fn();
  render(<PullDialog snapshot={{ ...preview, isClean: false, dirtyPaths: ["src/local.ts"], hasConflicts: true }} loading={false} busy={false} error="" disabled={false} disabledReason="" onRefresh={vi.fn()} onPull={onPull} onClose={vi.fn()} />);
  expect(screen.getByText("src/local.ts")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Unresolved conflicts are present.");
  expect(screen.getByRole("button", { name: "Pull with merge" }).hasAttribute("disabled")).toBe(true);
  expect(onPull).not.toHaveBeenCalled();
});

it("allows pull with local edits and explains automatic conflict resolution", () => {
  const onPull = vi.fn();
  render(<PullDialog snapshot={{ ...preview, isClean: false, dirtyPaths: ["local.txt"] }} loading={false} busy={false} error="" disabled={false} disabledReason="" onRefresh={vi.fn()} onPull={onPull} onClose={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toContain("conflicts open in the resolver");
  fireEvent.click(screen.getByRole("button", { name: "Pull with merge" }));
  expect(onPull).toHaveBeenCalledWith("merge");
});
