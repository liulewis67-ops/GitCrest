import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import {
  GitCrestApiError,
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";
import type { components } from "../../../api/schema";
import type { PushTarget } from "./push-target";

type PushTagsChoice = components["schemas"]["PushRequest"]["tags"];

interface RepositoryPushOptions {
  tasks: TaskSnapshotResponse[];
  getApi: () => GitCrestApiClient | undefined;
  repoId?: string;
  onSelectRepository: (repoId: string) => void;
  onTaskAccepted: (task: TaskSnapshotResponse, clearTaskError: boolean) => void;
}

export function useRepositoryPush({ tasks, getApi, repoId, onSelectRepository, onTaskAccepted }: RepositoryPushOptions) {
  const [open, setOpen] = useState(false);
  const [preflight, setPreflight] = useState<components["schemas"]["PushPreflight"]>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const [forceOnly, setForceOnly] = useState(false);
  const [target, setTarget] = useState<PushTarget>();
  const targetsByTask = useRef(new Map<string, PushTarget>());

  useEffect(() => {
    const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
    for (const taskId of targetsByTask.current.keys()) {
      const task = tasksById.get(taskId);
      if (!task || !["queued", "running", "failed"].includes(task.status)) {
        targetsByTask.current.delete(taskId);
      }
    }
  }, [tasks]);

  function acceptTask(task: TaskSnapshotResponse, pushTarget: PushTarget, clearTaskError: boolean) {
    targetsByTask.current.set(task.taskId, pushTarget);
    onTaskAccepted(task, clearTaskError);
  }

  function reviewTask(task: TaskSnapshotResponse, fallbackRepoId?: string) {
    if (!task.operation.startsWith("push") || task.status !== "failed") return false;
    const targetRepoId = task.repoId || fallbackRepoId;
    if (!targetRepoId) return false;
    openDialog(
      targetRepoId,
      targetsByTask.current.get(task.taskId),
      task.operation.startsWith("pushForceWithLease"),
    );
    return true;
  }

  async function refreshPreflight(targetRepoId = repoId, pushTarget: PushTarget | null = target || null) {
    const api = getApi();
    if (!api || !targetRepoId) return;
    setLoading(true);
    setError("");
    try {
      setPreflight(await api.preflightRepositoryPush(targetRepoId, pushTarget || undefined));
    } catch (requestError) {
      setPreflight(undefined);
      setError(describeApiError(requestError, t("err.pushPreview")));
    } finally {
      setLoading(false);
    }
  }

  function openDialog(targetRepoId = repoId, pushTarget?: PushTarget, onlyForce = false) {
    if (!targetRepoId) return;
    onSelectRepository(targetRepoId);
    setTarget(pushTarget);
    setForceOnly(onlyForce);
    setOpen(true);
    void refreshPreflight(targetRepoId, pushTarget || null);
  }

  async function submit(forceWithLease: boolean, tags: PushTagsChoice = "none") {
    const api = getApi();
    const preview = preflight;
    if (!api || !repoId || !preview || preview.repoId !== repoId || busy) return;
    setBusy(true);
    setError("");
    try {
      const task = await api.pushRepository(repoId, {
        expectedLocalOid: preview.localOid,
        expectedRemoteOid: preview.expectedRemoteOid,
        forceWithLease,
        remoteName: preview.remoteName,
        remoteBranch: preview.remoteBranch,
        tags,
      });
      acceptTask(task, { remoteName: preview.remoteName, remoteBranch: preview.remoteBranch }, true);
      setOpen(false);
    } catch (requestError) {
      setError(describeApiError(requestError, t("err.pushStart")));
      if (requestError instanceof GitCrestApiError && requestError.body.error.code === "PUSH_PREFLIGHT_STALE") {
        void refreshPreflight(repoId, target || null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function continueCommitPush(
    targetRepoId: string,
    intent: { target?: PushTarget; forceWithLease: boolean },
  ) {
    const api = getApi();
    if (!api) return;
    setTarget(intent.target);
    setForceOnly(intent.forceWithLease);
    setPreflight(undefined);
    setError("");
    setOpen(true);
    setLoading(true);
    try {
      const preview = await api.preflightRepositoryPush(targetRepoId, intent.target);
      setPreflight(preview);
      if (intent.forceWithLease || preview.behind > 0 || preview.ahead === 0) return;
      setBusy(true);
      const task = await api.pushRepository(targetRepoId, {
        expectedLocalOid: preview.localOid,
        expectedRemoteOid: preview.expectedRemoteOid,
        forceWithLease: false,
        remoteName: preview.remoteName,
        remoteBranch: preview.remoteBranch,
        tags: "none",
      });
      acceptTask(task, { remoteName: preview.remoteName, remoteBranch: preview.remoteBranch }, false);
      setOpen(false);
    } catch (requestError) {
      setError(describeApiError(requestError, t("err.pushAfterCommit")));
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }

  return {
    open,
    setOpen,
    preflight,
    loading,
    busy,
    error,
    forceOnly,
    refreshPreflight,
    openDialog,
    reviewTask,
    submit,
    continueCommitPush,
  };
}
