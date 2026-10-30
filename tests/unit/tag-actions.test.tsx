// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, RemoteTagPreviewResponse, TagEntryResponse, TaskSnapshotResponse } from "../../src/api/client";
import { TagActionsDialog } from "../../src/features/history/ui/TagActionsDialog";

afterEach(cleanup);

const A = "a".repeat(40);
const REMOTE_OID = "c".repeat(40);
const tag: TagEntryResponse = { name: "v1", targetOid: A, annotated: true, taggerName: "Ada", createdAtMs: 1, message: "Release" };
const task = { taskId: "t1" } as TaskSnapshotResponse;

function preview(overrides: Partial<RemoteTagPreviewResponse>): RemoteTagPreviewResponse {
  return { repoId: "repo_a", remoteName: "origin", name: "v1", remoteOid: null, localOid: REMOTE_OID, sameAsLocal: false, ...overrides };
}

function fakeApi(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}

function renderDialog(action: "push" | "delete" | "remoteDelete", api: GitCrestApiClient, handlers: { onDeleted?: () => void; onTaskStarted?: (task: TaskSnapshotResponse) => void } = {}) {
  render(<TagActionsDialog api={api} repoId="repo_a" action={action} tag={tag} remoteNames={["origin"]} onClose={vi.fn()} onDeleted={handlers.onDeleted ?? vi.fn()} onTaskStarted={handlers.onTaskStarted ?? vi.fn()} />);
}

describe("tag actions", () => {
  it("deletes a local tag only after confirmation, bound to the reviewed commit", async () => {
    const deleteRepositoryTag = vi.fn().mockResolvedValue({ repoId: "repo_a", name: "v1" });
    const onDeleted = vi.fn();
    renderDialog("delete", fakeApi({ deleteRepositoryTag }), { onDeleted });
    const run = screen.getByRole("button", { name: "Delete tag" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I reviewed this tag and want to delete it."));
    fireEvent.click(run);
    await waitFor(() => expect(deleteRepositoryTag).toHaveBeenCalledWith("repo_a", "v1", A));
    expect(onDeleted).toHaveBeenCalled();
  });

  it("pushes a tag the remote lacks", async () => {
    const pushRepositoryTag = vi.fn().mockResolvedValue(task);
    const onTaskStarted = vi.fn();
    renderDialog("push", fakeApi({ previewRemoteTag: vi.fn().mockResolvedValue(preview({})), pushRepositoryTag }), { onTaskStarted });
    expect(await screen.findByText("The remote does not have this tag yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Push tag" }));
    await waitFor(() => expect(pushRepositoryTag).toHaveBeenCalledWith("repo_a", "origin", "v1"));
    expect(onTaskStarted).toHaveBeenCalledWith(task);
  });

  it("refuses to push over a remote tag that points elsewhere", async () => {
    const pushRepositoryTag = vi.fn();
    renderDialog("push", fakeApi({ previewRemoteTag: vi.fn().mockResolvedValue(preview({ remoteOid: "d".repeat(40) })), pushRepositoryTag }));
    expect((await screen.findByRole("alert")).textContent).toContain("does not overwrite remote tags");
    expect((screen.getByRole("button", { name: "Push tag" }) as HTMLButtonElement).disabled).toBe(true);
    expect(pushRepositoryTag).not.toHaveBeenCalled();
  });

  it("deletes a remote tag with the previewed object as the lease", async () => {
    const deleteRemoteTag = vi.fn().mockResolvedValue(task);
    renderDialog("remoteDelete", fakeApi({ previewRemoteTag: vi.fn().mockResolvedValue(preview({ remoteOid: REMOTE_OID })), deleteRemoteTag }));
    await screen.findByText(/origin has this tag at object/);
    const run = screen.getByRole("button", { name: "Delete from remote" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I reviewed this tag and want to delete it."));
    fireEvent.click(run);
    await waitFor(() => expect(deleteRemoteTag).toHaveBeenCalledWith("repo_a", "origin", "v1", REMOTE_OID));
  });
});
