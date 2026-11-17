// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, StashEntryResponse, StashPreviewResponse, TaskSnapshotResponse } from "../../src/api/client";
import { StashActionDialog, type StashAction } from "../../src/features/shelves/ui/StashActionDialog";
import { StashList } from "../../src/features/shelves/ui/StashList";

afterEach(cleanup);

const OID = "a".repeat(40);
const HEAD = "b".repeat(40);
const task = { taskId: "t1" } as TaskSnapshotResponse;
const stash: StashEntryResponse = { index: 0, oid: OID, baseOid: HEAD, untrackedOid: null, branch: "main", message: "work", createdAtMs: 1_700_000_000_000 };

function preview(overrides: Partial<StashPreviewResponse> = {}): StashPreviewResponse {
  return {
    repoId: "repo_a", oid: OID, index: 0, headOid: HEAD, baseOid: HEAD, paths: ["src/a.ts", "new.txt"], omittedPathCount: 0,
    overlappingDirtyPaths: [], operationInProgress: false, canApply: true, ...overrides,
  };
}
function fakeApi(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { previewStash: vi.fn().mockResolvedValue(preview()), ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}
function renderDialog(action: StashAction, api: GitCrestApiClient, handlers: { onTaskStarted?: (task: TaskSnapshotResponse) => void; onChanged?: () => void; disabled?: boolean } = {}) {
  render(<StashActionDialog api={api} repoId="repo_a" stash={stash} action={action} disabled={handlers.disabled ?? false} onClose={vi.fn()} onTaskStarted={handlers.onTaskStarted ?? vi.fn()} onChanged={handlers.onChanged ?? vi.fn()} />);
}

describe("stash actions", () => {
  it("applies bound to the reviewed HEAD and hands the task on", async () => {
    const applyStash = vi.fn().mockResolvedValue(task);
    const onTaskStarted = vi.fn();
    renderDialog("apply", fakeApi({ applyStash }), { onTaskStarted });
    expect(await screen.findByText("src/a.ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply stash" }));
    await waitFor(() => expect(applyStash).toHaveBeenCalledWith("repo_a", OID, false, HEAD));
    expect(onTaskStarted).toHaveBeenCalledWith(task);
  });

  it("pops with the pop flag", async () => {
    const applyStash = vi.fn().mockResolvedValue(task);
    renderDialog("pop", fakeApi({ applyStash }));
    await screen.findByText("src/a.ts");
    fireEvent.click(screen.getByRole("button", { name: "Pop stash" }));
    await waitFor(() => expect(applyStash).toHaveBeenCalledWith("repo_a", OID, true, HEAD));
  });

  it("blocks applying over local edits and names the files", async () => {
    const applyStash = vi.fn();
    renderDialog("apply", fakeApi({ previewStash: vi.fn().mockResolvedValue(preview({ canApply: false, overlappingDirtyPaths: ["src/a.ts"] })), applyStash }));
    expect((await screen.findByRole("alert")).textContent).toContain("Commit or shelve them first");
    expect((screen.getByRole("button", { name: "Apply stash" }) as HTMLButtonElement).disabled).toBe(true);
    expect(applyStash).not.toHaveBeenCalled();
  });

  it("drops only after the user confirms", async () => {
    const dropStash = vi.fn().mockResolvedValue({ repoId: "repo_a", oid: OID });
    const onChanged = vi.fn();
    renderDialog("drop", fakeApi({ dropStash }), { onChanged });
    await screen.findByText("src/a.ts");
    const run = screen.getByRole("button", { name: "Drop stash" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I reviewed this stash and want to drop it."));
    fireEvent.click(run);
    await waitFor(() => expect(dropStash).toHaveBeenCalledWith("repo_a", OID));
    expect(onChanged).toHaveBeenCalled();
  });

  it("imports as a shelf and keeps the stash unless asked to drop it", async () => {
    const importStash = vi.fn().mockResolvedValue({ repoId: "repo_a", shelfId: "s1", name: "work", pathCount: 2, dropped: false });
    const onChanged = vi.fn();
    renderDialog("import", fakeApi({ importStash }), { onChanged });
    await screen.findByText("src/a.ts");
    fireEvent.click(screen.getByRole("button", { name: "Save as shelf" }));
    await waitFor(() => expect(importStash).toHaveBeenCalledWith("repo_a", OID, "work", false));
    expect(onChanged).toHaveBeenCalled();
  });

  it("can drop the stash after importing when the user opts in", async () => {
    const importStash = vi.fn().mockResolvedValue({ repoId: "repo_a", shelfId: "s1", name: "kept", pathCount: 2, dropped: true });
    renderDialog("import", fakeApi({ importStash }));
    await screen.findByText("src/a.ts");
    fireEvent.change(screen.getByLabelText("Shelf name"), { target: { value: "kept" } });
    fireEvent.click(screen.getByLabelText("Also drop the Git stash after the shelf is saved"));
    fireEvent.click(screen.getByRole("button", { name: "Save as shelf" }));
    await waitFor(() => expect(importStash).toHaveBeenCalledWith("repo_a", OID, "kept", true));
  });

  it("shows a failed action's reason and stays open", async () => {
    renderDialog("apply", fakeApi({ applyStash: vi.fn().mockRejectedValue(new Error("HEAD moved")) }));
    await screen.findByText("src/a.ts");
    fireEvent.click(screen.getByRole("button", { name: "Apply stash" }));
    expect((await screen.findByText("HEAD moved"))).toBeTruthy();
  });

  it.each([
    { dropAfter: false, dropStatus: undefined, feedback: "You can view it in Shelves." },
    { dropAfter: true, dropStatus: "failed", feedback: "the original stash could not be dropped" },
  ])("reports the import result and reloads the stash list", async ({ dropAfter, dropStatus, feedback }) => {
    const importStash = vi.fn().mockResolvedValue({ repoId: "repo_a", shelfId: "s1", name: "work", pathCount: 2, dropped: false, dropStatus });
    const getRepositoryStashes = vi.fn().mockResolvedValue({ repoId: "repo_a", stashes: [stash] });
    const api = fakeApi({
      getRepositoryStashes,
      importStash,
    });
    render(<StashList api={api} repoId="repo_a" refreshKey={0} onOpenFile={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for stash work" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Import as shelf…" }));
    await screen.findByText("src/a.ts");
    if (dropAfter) fireEvent.click(screen.getByLabelText("Also drop the Git stash after the shelf is saved"));
    fireEvent.click(screen.getByRole("button", { name: "Save as shelf" }));
    expect(await screen.findByText((value) => value.includes(feedback))).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Show files of stash work" })).toBeTruthy();
    await waitFor(() => expect(getRepositoryStashes).toHaveBeenCalledTimes(2));
  });
});
