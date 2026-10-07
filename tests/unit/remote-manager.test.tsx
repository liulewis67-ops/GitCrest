// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BranchSnapshotResponse, RemoteSnapshotResponse } from "../../src/api/client";
import { RemoteManager } from "../../src/features/remotes/RemoteManager";

afterEach(cleanup);

const snapshot: RemoteSnapshotResponse = {
  repoId: "repo_fixture",
  defaultRemote: "origin",
  remotes: [
    { name: "origin", fetchUrls: ["https://example.test/org/repo.git"], pushUrls: [], isDefault: true },
    { name: "upstream", fetchUrls: ["ssh://example.test/org/repo.git"], pushUrls: [], isDefault: false },
  ],
};

const branches: BranchSnapshotResponse = {
  repoId: "repo_fixture",
  current: "main",
  detached: false,
  branches: [
    { name: "main", fullName: "refs/heads/main", oid: "a".repeat(40), kind: "local", isCurrent: true, upstream: null, upstreamGone: false, ahead: null, behind: null, isFavorite: false },
    { name: "origin/main", fullName: "refs/remotes/origin/main", oid: "a".repeat(40), kind: "remote", isCurrent: false, upstream: null, upstreamGone: false, ahead: null, behind: null, isFavorite: false },
    { name: "upstream/main", fullName: "refs/remotes/upstream/main", oid: "a".repeat(40), kind: "remote", isCurrent: false, upstream: null, upstreamGone: false, ahead: null, behind: null, isFavorite: false },
  ],
};

it("exposes remote configuration and upstream actions through labeled controls", () => {
  const onAdd = vi.fn();
  const onSetUrl = vi.fn();
  const onDelete = vi.fn();
  const onSetDefault = vi.fn();
  const onSetUpstream = vi.fn();
  render(<RemoteManager snapshot={snapshot} branches={branches} loading={false} busy={false} disabled={false} disabledReason="" error="" onRefresh={vi.fn()} onAdd={onAdd} onSetUrl={onSetUrl} onDelete={onDelete} onSetDefault={onSetDefault} onSetUpstream={onSetUpstream} />);

  fireEvent.click(screen.getByRole("button", { name: "Manage remotes" }));
  const dialog = screen.getByRole("dialog", { name: "Manage remotes" });
  expect(within(dialog).getByText("https://example.test/org/repo.git")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Set default" }));
  expect(onSetDefault).toHaveBeenCalledWith("upstream");
  fireEvent.click(within(dialog).getByRole("button", { name: "Use automatic default (origin)" }));
  expect(onSetDefault).toHaveBeenCalledWith(null);

  const originCard = within(dialog).getByText("origin", { selector: "strong" }).closest("article");
  fireEvent.click(within(originCard!).getByRole("button", { name: "Edit URL" }));
  fireEvent.change(within(originCard!).getByLabelText("New URL"), { target: { value: "https://example.test/org/new.git" } });
  fireEvent.click(within(originCard!).getByRole("button", { name: "Save URL" }));
  expect(onSetUrl).toHaveBeenCalledWith("origin", "https://example.test/org/new.git");

  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "backup" } });
  fireEvent.change(within(dialog).getByLabelText("URL"), { target: { value: "https://example.test/org/backup.git" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add remote" }));
  expect(onAdd).toHaveBeenCalledWith("backup", "https://example.test/org/backup.git");

  fireEvent.change(within(dialog).getByLabelText("Local branch"), { target: { value: "main" } });
  fireEvent.change(within(dialog).getByLabelText("Remote"), { target: { value: "upstream" } });
  fireEvent.change(within(dialog).getByLabelText("Remote branch"), { target: { value: "main" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Set upstream" }));
  expect(onSetUpstream).toHaveBeenCalledWith("main", "upstream", "main");
});

it("requires a second explicit action before removing a remote", () => {
  const onDelete = vi.fn();
  render(<RemoteManager snapshot={snapshot} branches={branches} loading={false} busy={false} disabled={false} disabledReason="" error="" onRefresh={vi.fn()} onAdd={vi.fn()} onSetUrl={vi.fn()} onDelete={onDelete} onSetDefault={vi.fn()} onSetUpstream={vi.fn()} />);

  fireEvent.click(screen.getByRole("button", { name: "Manage remotes" }));
  const dialog = screen.getByRole("dialog", { name: "Manage remotes" });
  const upstream = within(dialog).getByText("upstream", { selector: "strong" }).closest("article");
  expect(upstream).not.toBeNull();
  fireEvent.click(within(upstream!).getByRole("button", { name: "Remove" }));
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(within(upstream!).getByRole("button", { name: "Confirm remove" }));
  expect(onDelete).toHaveBeenCalledWith("upstream");
});
