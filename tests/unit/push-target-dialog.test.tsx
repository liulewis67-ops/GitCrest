// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BranchSnapshotResponse, RemoteSnapshotResponse } from "../../src/api/client";
import { PushTargetDialog } from "../../src/features/remotes/PushTargetDialog";

afterEach(cleanup);

it("chooses a fetched branch from the selected remote without persisting an upstream change", () => {
  const remotes: RemoteSnapshotResponse = {
    repoId: "repo_fixture",
    defaultRemote: "origin",
    remotes: [
      { name: "origin", fetchUrls: ["https://example.test/a/repo.git"], pushUrls: ["https://example.test/a/repo.git"], isDefault: true },
      { name: "team/backup", fetchUrls: ["https://example.test/b/repo.git"], pushUrls: ["https://example.test/b/repo.git"], isDefault: false },
    ],
  };
  const branches: BranchSnapshotResponse = {
    repoId: "repo_fixture", current: "main", detached: false, branches: [
      { name: "main", fullName: "refs/heads/main", oid: "a".repeat(40), kind: "local", isCurrent: true, upstream: "origin/main", upstreamGone: false, ahead: 1, behind: 0, isFavorite: false },
      { name: "team/backup/release/2026", fullName: "refs/remotes/team/backup/release/2026", oid: "b".repeat(40), kind: "remote", isCurrent: false, upstream: null, upstreamGone: false, ahead: null, behind: null, isFavorite: false },
    ],
  };
  const onChoose = vi.fn();
  render(<PushTargetDialog remotes={remotes} branches={branches} disabled={false} disabledReason="" onChoose={onChoose} onClose={vi.fn()} />);

  fireEvent.change(screen.getByLabelText("Remote"), { target: { value: "team/backup" } });
  expect(screen.getByRole("option", { name: "release/2026" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review target" }));
  expect(onChoose).toHaveBeenCalledWith({ remoteName: "team/backup", remoteBranch: "release/2026" });
});
