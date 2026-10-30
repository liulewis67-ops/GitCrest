import { t } from "../../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import {
  GitCrestApiError,
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";

interface BranchSwitchShelfContext {
  repoId: string;
  target: string;
  /** The target is a remote-tracking branch, switched to through a local tracking branch. */
  remote?: boolean;
  /** The target is a commit id, checked out with a detached HEAD. */
  commit?: boolean;
  existingShelfIds: string[];
}

interface PendingShelfRestore {
  repoId: string;
  remainingShelfIds: string[];
}

interface ShelfAfterCreateAction { switchTarget: string; existingShelfIds: string[] }

interface BranchSwitchShelfFlowOptions {
  tasks: TaskSnapshotResponse[];
  getApi: () => GitCrestApiClient | undefined;
  getSelectedRepositoryId: () => string | undefined;
  branchSwitcher: {
    targetName: string;
    targetRemote: boolean;
    targetCommit: boolean;
    setError: (message: string) => void;
    close: () => void;
    runWhileBusy: <T>(action: () => Promise<T>) => Promise<T>;
  };
  requestShelfComposer: (repoId: string) => void;
  onBranchSwitchReview: (target: string, remote: boolean, preflight: Awaited<ReturnType<GitCrestApiClient["preflightRepositoryBranchSwitch"]>>, message: string, commit?: boolean) => void;
  appendTask: (task: TaskSnapshotResponse) => void;
  setTaskError: (message: string) => void;
  openTaskCenter: () => void;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof GitCrestApiError) return error.body.error.message;
  return error instanceof Error ? error.message : fallback;
}

function shelfSwitchKey(repoId: string, target: string) {
  return JSON.stringify([repoId, target]);
}

export function useBranchSwitchShelfFlow({
  tasks,
  getApi,
  getSelectedRepositoryId,
  branchSwitcher,
  requestShelfComposer,
  onBranchSwitchReview,
  appendTask,
  setTaskError,
  openTaskCenter,
}: BranchSwitchShelfFlowOptions) {
  const [shelfComposerAfterSwitch, setShelfComposerAfterSwitch] = useState<BranchSwitchShelfContext>();
  const switchAfterShelfRef = useRef(new Map<string, BranchSwitchShelfContext>());
  const applyAfterSwitchRef = useRef(new Map<string, BranchSwitchShelfContext>());
  const restoreAfterShelfRef = useRef(new Map<string, PendingShelfRestore>());
  const shelfBaselineRef = useRef(new Map<string, string[]>());
  const savedTargetsRef = useRef(new Set<string>());

  async function prepareShelfSwitch(repoId: string, target: string) {
    const api = getApi();
    if (!api) return undefined;
    const key = shelfSwitchKey(repoId, target);
    let existingShelfIds = shelfBaselineRef.current.get(key);
    if (!existingShelfIds) {
      const shelves = await api.listRepositoryShelves(repoId);
      existingShelfIds = shelves.map((shelf) => shelf.shelfId);
      shelfBaselineRef.current.set(key, existingShelfIds);
    }
    return existingShelfIds;
  }

  function trackShelfSwitchTask(task: TaskSnapshotResponse, context: BranchSwitchShelfContext) {
    switchAfterShelfRef.current.set(task.taskId, context);
    savedTargetsRef.current.add(shelfSwitchKey(context.repoId, context.target));
  }

  function closeShelfComposer(context: Pick<BranchSwitchShelfContext, "repoId" | "target">) {
    const key = shelfSwitchKey(context.repoId, context.target);
    if (!savedTargetsRef.current.has(key)) shelfBaselineRef.current.delete(key);
  }

  function prepareShelfComposerForBranchSwitch(context: BranchSwitchShelfContext) {
    setShelfComposerAfterSwitch(context);
  }

  async function openShelfComposerForBranchSwitch() {
    const repoId = getSelectedRepositoryId();
    const target = branchSwitcher.targetName;
    const remote = branchSwitcher.targetRemote;
    const commit = branchSwitcher.targetCommit;
    if (!repoId || !target) return;
    await branchSwitcher.runWhileBusy(async () => {
      branchSwitcher.setError("");
      try {
        const existingShelfIds = await prepareShelfSwitch(repoId, target);
        if (!existingShelfIds) return;
        prepareShelfComposerForBranchSwitch({ repoId, target, remote, commit, existingShelfIds });
        branchSwitcher.close();
        requestShelfComposer(repoId);
      } catch (error) {
        branchSwitcher.setError(errorMessage(error, t("bm.shelfPrepare")));
      }
    });
  }

  function onShelfComposerTaskSubmitted(task?: TaskSnapshotResponse, afterCreate?: ShelfAfterCreateAction) {
    if (!task || !afterCreate || !shelfComposerAfterSwitch) return;
    trackShelfSwitchTask(task, {
      repoId: shelfComposerAfterSwitch.repoId,
      target: afterCreate.switchTarget,
      remote: shelfComposerAfterSwitch.remote,
      commit: shelfComposerAfterSwitch.commit,
      existingShelfIds: afterCreate.existingShelfIds,
    });
    setShelfComposerAfterSwitch(undefined);
  }

  function onShelfComposerClosed() {
    if (shelfComposerAfterSwitch) closeShelfComposer(shelfComposerAfterSwitch);
    setShelfComposerAfterSwitch(undefined);
  }

  async function continueBranchSwitch(context: BranchSwitchShelfContext) {
    const api = getApi();
    if (!api) return;
    try {
      const preflight = await api.preflightRepositoryBranchSwitch(context.repoId, context.target, context.remote, context.commit);
      if (preflight.potentiallyOverwrittenPaths.length > 0) {
        if (getSelectedRepositoryId() === context.repoId) {
          onBranchSwitchReview(context.target, Boolean(context.remote), preflight, t("bm.remainOverlap"), Boolean(context.commit));
        } else {
          setTaskError(t("bm.remainPaths", { count: preflight.potentiallyOverwrittenPaths.length, target: context.target }));
        }
        return;
      }
      const task = await api.switchRepositoryBranch(context.repoId, context.target, context.remote, context.commit);
      applyAfterSwitchRef.current.set(task.taskId, context);
      appendTask(task);
      openTaskCenter();
    } catch (error) {
      setTaskError(errorMessage(error, t("bm.shelfContinue")));
    }
  }

  async function restoreShelvesAfterSwitch(context: BranchSwitchShelfContext) {
    const api = getApi();
    if (!api) return;
    try {
      const shelves = await api.listRepositoryShelves(context.repoId);
      const newlyCreated = shelves
        .filter((shelf) => !context.existingShelfIds.includes(shelf.shelfId))
        .sort((left, right) => left.createdAtMs - right.createdAtMs);
      if (newlyCreated.length === 0) {
        setTaskError(t("bm.shelfIdentify"));
        openTaskCenter();
        return;
      }
      const key = shelfSwitchKey(context.repoId, context.target);
      shelfBaselineRef.current.delete(key);
      savedTargetsRef.current.delete(key);
      await applyNextShelf(context.repoId, newlyCreated.map((shelf) => shelf.shelfId));
    } catch (error) {
      setTaskError(errorMessage(error, t("bm.shelfRestore")));
      openTaskCenter();
    }
  }

  async function applyNextShelf(repoId: string, shelfIds: string[]) {
    const [shelfId, ...remainingShelfIds] = shelfIds;
    if (!shelfId) return;
    const api = getApi();
    if (!api) return;
    try {
      const preview = await api.preflightRepositoryShelfApply(repoId, shelfId);
      if (!preview.canApplyCleanly && !preview.canApplyWithConflicts) {
        setTaskError(t("bm.shelfUnsafe"));
        openTaskCenter();
        return;
      }
      const task = await api.applyRepositoryShelf(repoId, shelfId, {
        expectedHeadOid: preview.expectedHeadOid,
        previewRevision: preview.previewRevision,
      });
      if (task.status === "succeeded") {
        appendTask(task);
        if (remainingShelfIds.length > 0) void applyNextShelf(repoId, remainingShelfIds);
      } else {
        restoreAfterShelfRef.current.set(task.taskId, { repoId, remainingShelfIds });
        appendTask(task);
      }
      openTaskCenter();
    } catch (error) {
      setTaskError(errorMessage(error, t("bm.shelfRestoreShort")));
      openTaskCenter();
    }
  }

  function observeTasks(tasks: TaskSnapshotResponse[]) {
    for (const task of tasks) {
      const switchAfterShelf = switchAfterShelfRef.current.get(task.taskId);
      if (switchAfterShelf && !["queued", "running"].includes(task.status)) {
        switchAfterShelfRef.current.delete(task.taskId);
        if (task.status === "succeeded") void continueBranchSwitch(switchAfterShelf);
      }

      const applyAfterSwitch = applyAfterSwitchRef.current.get(task.taskId);
      if (applyAfterSwitch && !["queued", "running"].includes(task.status)) {
        applyAfterSwitchRef.current.delete(task.taskId);
        if (task.status === "succeeded") void restoreShelvesAfterSwitch(applyAfterSwitch);
      }

      const pendingRestore = restoreAfterShelfRef.current.get(task.taskId);
      if (pendingRestore && task.status === "succeeded") {
        restoreAfterShelfRef.current.delete(task.taskId);
        if (pendingRestore.remainingShelfIds.length > 0) void applyNextShelf(pendingRestore.repoId, pendingRestore.remainingShelfIds);
      } else if (pendingRestore && ["failed", "cancelled"].includes(task.status)) {
        restoreAfterShelfRef.current.delete(task.taskId);
        if (pendingRestore.remainingShelfIds.length > 0) {
          setTaskError("A shelf restore did not finish. The remaining shelves are still saved and can be applied manually.");
          openTaskCenter();
        }
      }
    }
  }

  useEffect(() => {
    observeTasks(tasks);
  }, [tasks]);

  return {
    shelfComposerAfterSwitch,
    openShelfComposerForBranchSwitch,
    onShelfComposerTaskSubmitted,
    onShelfComposerClosed,
  };
}
