// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import { PushDialog } from "../../src/features/remotes/PushDialog";

afterEach(cleanup);

const preview: components["schemas"]["PushPreflight"] = {
  repoId: "repo_fixture",
  localBranch: "feature/change",
  remoteName: "origin",
  remoteBranch: "feature/change",
  localOid: "a".repeat(40),
  expectedRemoteOid: "b".repeat(40),
  ahead: 2,
  behind: 1,
  commitsToPush: [{ oid: "a".repeat(40), subject: "local change" }, { oid: "c".repeat(40), subject: "second local change" }],
  overwrittenCommitCount: 1,
  changedPaths: ["src/file.ts", "README.md"],
  changedPathCount: 2,
  omittedChangedPathCount: 0,
};

it("shows the target and overwrite scope, then requires explicit force-with-lease confirmation", () => {
  const onPush = vi.fn();
  render(<PushDialog snapshot={preview} loading={false} busy={false} error="" disabled={false} disabledReason="" onRefresh={vi.fn()} onFetch={vi.fn()} onPush={onPush} onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog", { name: "Push current branch" });
  expect(within(dialog).getByText("origin/feature/change")).toBeTruthy();
  expect(within(dialog).getByText("local change")).toBeTruthy();
  expect(within(dialog).getByText("src/file.ts")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Force with lease…" }));
  expect(within(dialog).getByRole("alertdialog", { name: "Confirm force with lease" })).toBeTruthy();
  expect(onPush).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm force-with-lease" }));
  expect(onPush).toHaveBeenCalledWith(true);
});

it("offers normal push only when the remote has no unseen commits", () => {
  const onPush = vi.fn();
  render(<PushDialog snapshot={{ ...preview, behind: 0, overwrittenCommitCount: 0 }} loading={false} busy={false} error="" disabled={false} disabledReason="" onRefresh={vi.fn()} onFetch={vi.fn()} onPush={onPush} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Push" }));
  expect(onPush).toHaveBeenCalledWith(false);
  expect(screen.queryByRole("button", { name: /Force with lease/ })).toBeNull();
});

it("keeps a selected force action behind the lease confirmation even for a fast-forward", () => {
  const onPush = vi.fn();
  render(<PushDialog snapshot={{ ...preview, behind: 0, overwrittenCommitCount: 0 }} loading={false} busy={false} error="" disabled={false} disabledReason="" forceWithLeaseOnly onRefresh={vi.fn()} onFetch={vi.fn()} onPush={onPush} onClose={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Force with lease…" }));
  expect(screen.getByText("Confirm lease-protected push?")).toBeTruthy();
  expect(onPush).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm force-with-lease" }));
  expect(onPush).toHaveBeenCalledWith(true);
});
