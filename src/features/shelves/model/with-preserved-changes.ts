import type { GitCrestApiClient, ShelfCreateRequest, TaskSnapshotResponse } from "../../../api/client";
import { t } from "../../../shared/i18n";

/** Uses saved shelves so interrupted operations always leave a recoverable copy. */
export async function withPreservedChanges(
  api: GitCrestApiClient,
  repoId: string,
  run: () => Promise<TaskSnapshotResponse>,
  onTask: (task: TaskSnapshotResponse) => void,
) {
  const saved: string[] = [];

  async function finish(initial: TaskSnapshotResponse) {
    let task = initial;
    onTask(task);
    while (["queued", "running", "waitingForInput"].includes(task.status)) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const next = (await api.listTasks()).find((entry) => entry.taskId === task.taskId);
      if (!next) throw new Error(t("preserve.taskMissing"));
      if (next.status !== task.status) onTask(next);
      task = next;
    }
    if (task.status !== "succeeded") throw new Error(task.message || t("preserve.failed"));
  }

  // Check every scope before removing anything, including files edited both in the index and worktree.
  const repository = await api.getRepository(repoId);
  const status = await api.getRepositoryStatus(repoId, true);
  const groups: ShelfCreateRequest["items"][] = [];
  for (const scope of ["workingTree", "index"] as const) {
    const files = status.files.filter((file) => !file.categories.includes("ignored") && (scope === "index"
      ? file.categories.includes("staged")
      : file.categories.includes("unstaged") || file.categories.includes("untracked")));
    const items: ShelfCreateRequest["items"] = [];
    for (const file of files) {
      const diff = await api.getFileDiff(repoId, file.path, scope);
      if (diff.status !== "text" || diff.hunks.length === 0) {
        throw new Error(t("preserve.unsupported", { path: file.path }));
      }
      items.push({ path: file.path, scope, revision: diff.revision, selections: [] });
    }
    // The shelf API accepts at most 100 files per request.
    for (let offset = 0; offset < items.length; offset += 100) groups.push(items.slice(offset, offset + 100));
  }
  if (status.files.some((file) => file.categories.includes("conflicted"))) throw new Error(t("pull.conflicts"));

  async function restore() {
    // Index changes must be restored before the edits that were based on them.
    for (const shelfId of [...saved].reverse()) {
      const preview = await api.preflightRepositoryShelfApply(repoId, shelfId);
      if (!preview.canApplyCleanly && !preview.canApplyWithConflicts) throw new Error(t("preserve.restore"));
      await finish(await api.applyRepositoryShelf(repoId, shelfId, {
        expectedHeadOid: preview.expectedHeadOid,
        previewRevision: preview.previewRevision,
      }));
      // The apply task consumes the shelf only after a successful restore.
    }
  }

  try {
    for (const items of groups) {
      const name = `GitCrest ${crypto.randomUUID()}`;
      // Re-read revisions after previous shelves have changed the working tree.
      for (const item of items) item.revision = (await api.getFileDiff(repoId, item.path, item.scope)).revision;
      await finish(await api.createRepositoryShelf(repoId, {
        name,
        description: t("preserve.description"),
        expectedHeadOid: repository.head,
        items,
      }));
      const shelf = (await api.listRepositoryShelves(repoId)).find((entry) => entry.name === name);
      if (!shelf) throw new Error(t("preserve.taskMissing"));
      saved.push(shelf.shelfId);
    }
    await finish(await run());
  } catch (error) {
    // Do not retry an operation. Restore what was saved, or leave the backups for manual recovery.
    try { await restore(); } catch { throw new Error(t("preserve.restore")); }
    throw error;
  }
  await restore();
}
