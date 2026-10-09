import { useEffect, useRef, useState } from "react";
import {
  GitCrestApiError,
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";

interface BranchSwitchShelfContext {
  repoId: string;
  target: string;
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
    setError: (message: string) => void;
    close: () => void;
    runWhileBusy: <T>(action: () => Promise<T>) => Promise<T>;
  };
  requestShelfComposer: (repoId: string) => void;
  onBranchSwitchReview: (target: string, preflight: Awaited<ReturnType<GitCrestApiClient["preflightRepositoryBranchSwitch"]>>, message: string) => void;
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
    if (!repoId || !target) return;
    await branchSwitcher.runWhileBusy(async () => {
      branchSwitcher.setError("");
      try {
        const existingShelfIds = await prepareShelfSwitch(repoId, target);
        if (!existingShelfIds) return;
        prepareShelfComposerForBranchSwitch({ repoId, target, existingShelfIds });
        branchSwitcher.close();
        requestShelfComposer(repoId);
      } catch (error) {
        branchSwitcher.setError(errorMessage(error, "Could not prepare the shelf before switching branches."));
      }
    });
  }

  function onShelfComposerTaskSubmitted(task?: TaskSnapshotResponse, afterCreate?: ShelfAfterCreateAction) {
    if (!task || !afterCreate || !shelfComposerAfterSwitch) return;
    trackShelfSwitchTask(task, {
      repoId: shelfComposerAfterSwitch.repoId,
      target: afterCreate.switchTarget,
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
      const preflight = await api.preflightRepositoryBranchSwitch(context.repoId, context.target);
      if (preflight.potentiallyOverwrittenPaths.length > 0) {
        if (getSelectedRepositoryId() === context.repoId) {
          onBranchSwitchReview(context.target, preflight, "Some changes remain on paths the target branch updates. Shelve or commit them, then review the switch again.");
        } else {
          setTaskError(`The shelf was created, but ${preflight.potentiallyOverwrittenPaths.length} remaining path(s) still overlap ${context.target}. Reopen that repository to review the switch.`);
        }
        return;
      }
      const task = await api.switchRepositoryBranch(context.repoId, context.target);
      applyAfterSwitchRef.current.set(task.taskId, context);
      appendTask(task);
      openTaskCenter();
    } catch (error) {
      setTaskError(errorMessage(error, "The shelf was created, but GitCrest could not continue the branch switch."));
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
        setTaskError("The branch switched, but GitCrest could not identify the newly created shelf. Review the shelf list and restore it manually.");
        openTaskCenter();
        return;
      }
      const key = shelfSwitchKey(context.repoId, context.target);
      shelfBaselineRef.current.delete(key);
      savedTargetsRef.current.delete(key);
      await applyNextShelf(context.repoId, newlyCreated.map((shelf) => shelf.shelfId));
    } catch (error) {
      setTaskError(errorMessage(error, "The branch switched, but GitCrest could not restore the saved shelf."));
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
        setTaskError("The branch switched, but a saved shelf cannot be restored safely on this branch. Review and apply the remaining shelf manually.");
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
      setTaskError(errorMessage(error, "GitCrest could not restore the saved shelf."));
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
