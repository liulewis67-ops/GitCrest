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
import { pushNotice } from "../../../shared/notices/notice-store";

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
  const inFlight = useRef(false);

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
      true,
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

  async function openDialog(targetRepoId = repoId, pushTarget?: PushTarget, onlyForce = false, reviewOnly = false) {
    if (!targetRepoId) return;
    onSelectRepository(targetRepoId);
    await startPush(targetRepoId, pushTarget, onlyForce, reviewOnly, true, t("err.pushStart"));
  }

  async function startPush(targetRepoId: string, pushTarget: PushTarget | undefined, onlyForce: boolean, reviewOnly: boolean, clearTaskError: boolean, fallback: string) {
    const api = getApi();
    if (!api || inFlight.current) return;
    inFlight.current = true;
    setTarget(pushTarget);
    setForceOnly(onlyForce);
    setPreflight(undefined);
    setError("");
    setOpen(false);
    setLoading(true);
    try {
      const preview = await api.preflightRepositoryPush(targetRepoId, pushTarget);
      setPreflight(preview);
      if (preview.repoId !== targetRepoId) throw new Error(t("err.pushPreview"));
      if (onlyForce || reviewOnly || preview.behind > 0 || preview.overwrittenCommitCount > 0) {
        setOpen(true);
        return;
      }
      if (preview.ahead === 0) {
        pushNotice({ key: `push-current:${targetRepoId}`, kind: "success", message: t("push.upToDate") });
        return;
      }
      setBusy(true);
      acceptTask(await api.pushRepository(targetRepoId, {
        expectedLocalOid: preview.localOid, expectedRemoteOid: preview.expectedRemoteOid,
        forceWithLease: false, remoteName: preview.remoteName, remoteBranch: preview.remoteBranch, tags: "none",
      }), { remoteName: preview.remoteName, remoteBranch: preview.remoteBranch }, clearTaskError);
    } catch (requestError) {
      setError(describeApiError(requestError, fallback));
      setOpen(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
      setBusy(false);
    }
  }

  async function submit(forceWithLease: boolean, tags: PushTagsChoice = "none") {
    const api = getApi();
    const preview = preflight;
    if (!api || !repoId || !preview || preview.repoId !== repoId || inFlight.current) return;
    inFlight.current = true;
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
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function continueCommitPush(
    targetRepoId: string,
    intent: { target?: PushTarget; forceWithLease: boolean },
  ) {
    await startPush(targetRepoId, intent.target, intent.forceWithLease, false, false, t("err.pushAfterCommit"));
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
