import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, ShelfCreateRequest, TaskSnapshotResponse } from "../../src/api/client";
import { withPreservedChanges } from "../../src/features/shelves/model/with-preserved-changes";
import { GitCrestApiError } from "../../src/api/client";

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

it("keeps source-branch shelves without applying edits to the target branch", async () => {
  const { api, run, onTask } = setup();
  api.getRepository.mockResolvedValue({ head: "head", branch: "feature/source" });
  await withPreservedChanges(api as unknown as GitCrestApiClient, "repo", run, onTask, { keepOnSourceBranch: true });
  expect(run).toHaveBeenCalledOnce();
  expect(api.applyRepositoryShelf).not.toHaveBeenCalled();
  expect(await api.listRepositoryShelves()).toHaveLength(2);
  expect(api.createRepositoryShelf.mock.calls[0][1]).toMatchObject({ name: expect.stringContaining("[feature/source]"), description: expect.stringContaining("feature/source") });
});

it("restores source-branch changes if a keep-on-source switch fails", async () => {
  const { api, run, onTask, task, events } = setup();
  run.mockResolvedValueOnce({ ...task("switchBranch", "failed"), message: "switch failed" });
  await expect(withPreservedChanges(api as unknown as GitCrestApiClient, "repo", run, onTask, { keepOnSourceBranch: true })).rejects.toThrow("switch failed");
  expect(events.slice(-2)).toEqual(["restore:index", "restore:workingTree"]);
});

it("preserves staged, unstaged and untracked edits and restores the index first", async () => {
  const { execute, api, events } = setup();
  await execute();
  expect(events).toEqual(["save:workingTree", "save:index", "run", "restore:index", "restore:workingTree"]);
  expect(api.createRepositoryShelf.mock.calls[0][1].items.map((item) => item.path)).toEqual(["both.txt", "new.txt"]);
});

it("restores local edits when pull fails", async () => {
  const { execute, run, events, task } = setup();
  run.mockResolvedValueOnce({ ...task("pullMerge", "failed"), message: "fetch failed" });
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
  await expect(execute()).rejects.toThrow();
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

it("keeps backups when the pull response is lost and the server may still be running", async () => {
  const { execute, api, run } = setup();
  run.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await expect(execute()).rejects.toThrow();
  expect(api.applyRepositoryShelf).not.toHaveBeenCalled();
  expect(await api.listRepositoryShelves()).toHaveLength(2);
});

it("retains dependent backups when a cancelled shelf creation may have partially cleaned the index", async () => {
  const { execute, api, task, run } = setup();
  const create = api.createRepositoryShelf.getMockImplementation()!;
  api.createRepositoryShelf.mockImplementationOnce(create)
    .mockImplementationOnce(async () => task("shelfCreate:index", "cancelled"));
  await expect(execute()).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  expect(api.applyRepositoryShelf).not.toHaveBeenCalled();
});

it("tracks a clean operation through completion before accepting another operation", async () => {
  vi.useFakeTimers();
  const { execute, api, task, run } = setup();
  api.getRepositoryStatus.mockResolvedValue({ files: [] });
  run.mockResolvedValueOnce(task("pullMerge", "running"));
  api.listTasks.mockResolvedValue([task("pullMerge")]);
  const pending = execute();
  await vi.advanceTimersByTimeAsync(0);
  await expect(execute()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(600);
  await pending;
  await execute();
  expect(api.createRepositoryShelf).not.toHaveBeenCalled();
});

it("blocks a second operation until the first operation has restored its changes", async () => {
  const { execute, api, run, task } = setup();
  let complete!: (task: TaskSnapshotResponse) => void;
  run.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const first = execute();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // The first operation has shelved everything, so the worktree now looks clean.
  api.getRepositoryStatus.mockResolvedValue({ files: [] });
  const second = execute();
  const rejected = expect(second).rejects.toThrow();
  complete(task("pullMerge"));
  await first;
  await rejected;
  expect(run).toHaveBeenCalledTimes(1);
  // Once restoration completes, another operation may proceed.
  await execute();
  expect(run).toHaveBeenCalledTimes(2);
});

it("does not restore dependent edits while a shelf creation outcome is unknown", async () => {
  vi.useFakeTimers();
  const { execute, api, task, run } = setup();
  const create = api.createRepositoryShelf.getMockImplementation()!;
  api.createRepositoryShelf.mockImplementationOnce(create)
    .mockImplementationOnce(async () => task("shelfCreate:index", "running"));
  // First creation is identified, but the second task disappears during polling.
  api.listTasks.mockResolvedValue([]);
  const pending = expect(execute()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(600);
  await pending;
  expect(run).not.toHaveBeenCalled();
  expect(api.applyRepositoryShelf).not.toHaveBeenCalled();
});

it("runs safe operations without reading diffs or creating shelves, including binary edits", async () => {
  const { api, run, onTask, events } = setup();
  api.getFileDiff.mockResolvedValue({ status: "binary", hunks: [], revision: "binary" });
  await withPreservedChanges(api as unknown as GitCrestApiClient, "repo", run, onTask, { saveBeforeOperation: false });
  expect(events).toEqual(["run"]);
  expect(api.getFileDiff).not.toHaveBeenCalled();
  expect(api.createRepositoryShelf).not.toHaveBeenCalled();
  expect(api.applyRepositoryShelf).not.toHaveBeenCalled();
});

it.each(["BRANCH_WORKTREE_DIRTY", "PULL_REQUIRES_CLEAN"] as const)("preserves and retries only after the server refuses before submission: %s", async (code) => {
  const { api, run, onTask, events } = setup();
  run.mockRejectedValueOnce(new GitCrestApiError(409, { error: { code, message: "preserve first" } }));
  await withPreservedChanges(api as unknown as GitCrestApiClient, "repo", run, onTask, { saveBeforeOperation: false });
  expect(run).toHaveBeenCalledTimes(2);
  expect(events).toEqual(["save:workingTree", "save:index", "run", "restore:index", "restore:workingTree"]);
});

it.each(["failed", "cancelled"])("does not save or retry a direct operation whose task ends %s", async (status) => {
  const { api, run, onTask, task } = setup();
  run.mockResolvedValueOnce(task("pullMerge", status));
  await expect(withPreservedChanges(api as unknown as GitCrestApiClient, "repo", run, onTask, { saveBeforeOperation: false })).rejects.toThrow();
  expect(run).toHaveBeenCalledOnce();
  expect(api.createRepositoryShelf).not.toHaveBeenCalled();
});

it("does not save or retry after a lost direct-operation response", async () => {
  const { api, run, onTask } = setup();
  run.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await expect(withPreservedChanges(api as unknown as GitCrestApiClient, "repo", run, onTask, { saveBeforeOperation: false })).rejects.toThrow();
  expect(run).toHaveBeenCalledOnce();
  expect(api.createRepositoryShelf).not.toHaveBeenCalled();
});
