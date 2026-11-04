import { GitCrestApiError, type GitCrestApiClient, type ShelfCreateRequest, type TaskSnapshotResponse } from "../../../api/client";
import { t } from "../../../shared/i18n";

const activeRepositories = new Set<string>();

export interface PreserveChangesOptions {
  /** False when preflight says Git can keep edits in place. */
  saveBeforeOperation?: boolean;
  /** Leave the saved shelves on the source branch after a successful switch. */
  keepOnSourceBranch?: boolean;
}

/** Keeps safe edits in place and uses recoverable shelves when preservation is needed. */
export async function withPreservedChanges(
  api: GitCrestApiClient,
  repoId: string,
  run: () => Promise<TaskSnapshotResponse>,
  onTask: (task: TaskSnapshotResponse) => void,
  options: PreserveChangesOptions = {},
) {
  if (activeRepositories.has(repoId)) throw new Error(t("preserve.busy"));
  activeRepositories.add(repoId);
  try {
    await preserveChanges(api, repoId, run, onTask, options);
  } finally {
    activeRepositories.delete(repoId);
  }
}

async function preserveChanges(
  api: GitCrestApiClient,
  repoId: string,
  run: () => Promise<TaskSnapshotResponse>,
  onTask: (task: TaskSnapshotResponse) => void,
  options: PreserveChangesOptions,
) {
  const saved: string[] = [];
  let outcomeUnknown = false;
  let savingShelf = false;

  async function submit(action: () => Promise<TaskSnapshotResponse>) {
    // A lost response does not mean the server rejected the task.
    outcomeUnknown = true;
    try {
      const task = await action();
      await finish(task);
    } catch (error) {
      if (error instanceof GitCrestApiError && error.status >= 400 && error.status < 500) outcomeUnknown = false;
      throw error;
    }
  }

  async function finish(initial: TaskSnapshotResponse) {
    let task = initial;
    onTask(task);
    while (["queued", "running", "waitingForInput"].includes(task.status)) {
      outcomeUnknown = true;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const next = (await api.listTasks()).find((entry) => entry.taskId === task.taskId);
      if (!next) throw new Error(t("preserve.taskMissing"));
      if (next.status !== task.status) onTask(next);
      task = next;
    }
    outcomeUnknown = false;
    if (task.status !== "succeeded") throw new Error(task.message || t("preserve.failed"));
  }

  if (options.saveBeforeOperation === false && !options.keepOnSourceBranch) {
    try {
      await submit(run);
      return;
    } catch (error) {
      // Only these pre-submission refusals prove the operation never started.
      // Failed/cancelled tasks and lost responses must never trigger a retry.
      if (!(error instanceof GitCrestApiError) || error.status !== 409
        || !["BRANCH_WORKTREE_DIRTY", "PULL_REQUIRES_CLEAN"].includes(error.body.error.code)) throw error;
    }
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
      const source = repository.branch || repository.head?.slice(0, 12) || "HEAD";
      // Keep the branch label inside the shelf API's 120-character name limit.
      const sourceLabel = [...source].length > 64 ? `${[...source].slice(0, 63).join("")}…` : source;
      const name = options.keepOnSourceBranch ? `GitCrest [${sourceLabel}] ${crypto.randomUUID()}` : `GitCrest ${crypto.randomUUID()}`;
      // Re-read revisions after previous shelves have changed the working tree.
      for (const item of items) item.revision = (await api.getFileDiff(repoId, item.path, item.scope)).revision;
      savingShelf = true;
      await submit(() => api.createRepositoryShelf(repoId, {
        name,
        description: options.keepOnSourceBranch ? t("bc.shelfDescription", { branch: sourceLabel }) : t("preserve.description"),
        expectedHeadOid: repository.head,
        items,
      }));
      outcomeUnknown = true;
      const shelf = (await api.listRepositoryShelves(repoId)).find((entry) => entry.name === name);
      if (!shelf) throw new Error(t("preserve.taskMissing"));
      saved.push(shelf.shelfId);
      outcomeUnknown = false;
      savingShelf = false;
    }
    await submit(run);
  } catch (error) {
    // A task may still be removing changes. Restoring now can race with it or
    // restore worktree edits before their index baseline has been recovered.
    if (outcomeUnknown || savingShelf) throw new Error(t("preserve.taskMissing"));
    // Do not retry an operation. Restore what was saved, or leave the backups for manual recovery.
    try { await restore(); } catch { throw new Error(t("preserve.restore")); }
    throw error;
  }
  if (!options.keepOnSourceBranch) {
    try { await restore(); } catch { throw new Error(t("preserve.restore")); }
  }
}
