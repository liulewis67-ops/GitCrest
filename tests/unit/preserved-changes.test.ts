import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, ShelfCreateRequest, TaskSnapshotResponse } from "../../src/api/client";
import { withPreservedChanges } from "../../src/features/shelves/model/with-preserved-changes";

afterEach(() => vi.useRealTimers());

function setup() {
  const events: string[] = [];
  const shelves: { shelfId: string; name: string }[] = [];
  const task = (operation: string, status = "succeeded") => ({ taskId: operation, operation, status, repoId: "repo" }) as TaskSnapshotResponse;
  const api = {
    getRepository: vi.fn().mockResolvedValue({ head: "head" }),
    getRepositoryStatus: vi.fn().mockResolvedValue({ files: [
      { path: "both.txt", categories: ["staged", "unstaged"] },
      { path: "new.txt", categories: ["untracked"] },
    ] }),
    getFileDiff: vi.fn().mockResolvedValue({ status: "text", hunks: [{}], revision: "rev" }),
    createRepositoryShelf: vi.fn(async (_repo, request: ShelfCreateRequest) => {
      const scope = request.items[0].scope;
      events.push(`save:${scope}`);
      shelves.push({ shelfId: scope, name: request.name });
      return task(`shelfCreate:${scope}`);
    }),
    listRepositoryShelves: vi.fn(async () => shelves),
    preflightRepositoryShelfApply: vi.fn(async (_repo, id) => ({ canApplyCleanly: true, canApplyWithConflicts: false, expectedHeadOid: "next", previewRevision: id })),
    applyRepositoryShelf: vi.fn(async (_repo, id) => { events.push(`restore:${id}`); return task(`shelfApply:${id}`); }),
    listTasks: vi.fn(),
  };
  const run = vi.fn(async () => { events.push("run"); return task("pullMerge"); });
  const onTask = vi.fn();
  const execute = () => withPreservedChanges(api as unknown as GitCrestApiClient, "repo", run, onTask);
  return { api, run, events, task, onTask, execute };
}

it("preserves staged, unstaged and untracked edits and restores the index first", async () => {
  const { execute, api, events } = setup();
  await execute();
  expect(events).toEqual(["save:workingTree", "save:index", "run", "restore:index", "restore:workingTree"]);
  expect(api.createRepositoryShelf.mock.calls[0][1].items.map((item) => item.path)).toEqual(["both.txt", "new.txt"]);
});

it("restores local edits when pull fails", async () => {
  const { execute, run, events } = setup();
  run.mockRejectedValueOnce(new Error("fetch failed"));
  await expect(execute()).rejects.toThrow("fetch failed");
  expect(events.slice(-2)).toEqual(["restore:index", "restore:workingTree"]);
});

it("publishes a conflicting restore for the automatic resolver and waits before restoring more", async () => {
  vi.useFakeTimers();
  const { execute, api, events, task, onTask } = setup();
  api.preflightRepositoryShelfApply.mockResolvedValue({ canApplyCleanly: false, canApplyWithConflicts: true, expectedHeadOid: "next", previewRevision: "rev" });
  api.applyRepositoryShelf.mockImplementationOnce(async () => {
    events.push("restore:index");
    return task("shelfApply:index", "waitingForInput");
  });
  api.listTasks.mockResolvedValue([task("shelfApply:index")]);
  const pending = execute();
  await vi.advanceTimersByTimeAsync(0);
  expect(onTask).toHaveBeenCalledWith(expect.objectContaining({ status: "waitingForInput", operation: "shelfApply:index" }));
  expect(events).not.toContain("restore:workingTree");
  await vi.advanceTimersByTimeAsync(600);
  await pending;
  expect(events[events.length - 1]).toBe("restore:workingTree");
});

it("checks unsupported files before creating shelves or starting the operation", async () => {
  const { execute, api, run } = setup();
  api.getFileDiff.mockResolvedValueOnce({ status: "binary", hunks: [], revision: "binary" });
  await expect(execute()).rejects.toThrow("both.txt");
  expect(api.createRepositoryShelf).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("leaves the shelf available if restoration is unsafe", async () => {
  const { execute, api } = setup();
  api.preflightRepositoryShelfApply.mockResolvedValue({ canApplyCleanly: false, canApplyWithConflicts: false, expectedHeadOid: "next", previewRevision: "rev" });
  await expect(execute()).rejects.toThrow("Shelves");
  expect(api.applyRepositoryShelf).not.toHaveBeenCalled();
});
