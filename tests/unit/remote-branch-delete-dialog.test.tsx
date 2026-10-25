// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RemoteBranchDeletePreviewResponse, RemoteSnapshotResponse } from "../../src/api/client";
import { RemoteBranchDeleteDialog } from "../../src/features/branches/ui/RemoteBranchDeleteDialog";

afterEach(cleanup);

const remotes: RemoteSnapshotResponse = {
  repoId: "repo_fixture",
  defaultRemote: "origin",
  remotes: [{ name: "origin", fetchUrls: ["https://example.test/repo.git"], pushUrls: ["https://example.test/repo.git"], isDefault: true }],
};

const preview: RemoteBranchDeletePreviewResponse = {
  repoId: "repo_fixture",
  remoteName: "origin",
  remoteBranch: "feature",
  targetRef: "refs/remotes/origin/feature",
  expectedRemoteOid: "a".repeat(40),
  currentHeadOid: "b".repeat(40),
  commitsOnlyOnRemote: 3,
  affectedPaths: ["src/one.ts", "src/two.ts"],
  omittedPathCount: 1,
  operationInProgress: null,
  previewRevision: `sha256:${"c".repeat(64)}`,
  canDelete: true,
};

it("explains the remote ref, lease OID and actual preview impact before confirmation", async () => {
  const api = {
    previewRepositoryRemoteBranchDelete: vi.fn().mockResolvedValue(preview),
    deleteRepositoryRemoteBranch: vi.fn(),
  } as unknown as import("../../src/api/client").GitCrestApiClient;
  render(<RemoteBranchDeleteDialog api={api} repoId="repo_fixture" branchRef={preview.targetRef} remotes={remotes} disabled={false} onClose={vi.fn()} onStarted={vi.fn()} />);

  fireEvent.click(screen.getByRole("button", { name: "Review impact" }));
  const explanation = await screen.findByRole("region", { name: "Remote branch deletion impact explanation" });
  expect(explanation.textContent).toContain("origin/feature");
  expect(explanation.textContent).toContain(preview.expectedRemoteOid.slice(0, 12));
  expect(explanation.textContent).toContain("3 commit(s) reachable only from that remote branch");
  expect(explanation.textContent).toContain("2 path(s) that differ from the current HEAD; 1 additional path(s) are omitted");
  expect(explanation.textContent).toContain("based on the reviewed remote preview");
  expect(api.deleteRepositoryRemoteBranch).not.toHaveBeenCalled();
});
