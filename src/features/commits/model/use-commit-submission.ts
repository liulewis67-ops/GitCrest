import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useRef, useState } from "react";
import {
  GitCrestApiError,
  type CommitRequest,
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";
import type { CommitAction } from "./commit-action";
import type { PushTarget } from "../../remotes";

type CommitSelections = NonNullable<CommitRequest["selections"]>;
type CommitIntent = { action: CommitAction; target?: PushTarget; forceWithLease: boolean };

interface CommitTaskContext {
  selections: string;
  message: string;
  intent: CommitIntent;
}

interface CommitSubmissionOptions {
  getApi: () => GitCrestApiClient | undefined;
  repoId?: string;
  message: string;
  selections: CommitSelections;
  amend: boolean;
  signOff: boolean;
  sign: boolean;
  setSelections: (selections: CommitSelections) => void;
  appendTask: (task: TaskSnapshotResponse) => void;
  setTaskError: (message: DisplayError) => void;
  openTaskCenter: () => void;
  openPushTargetPicker: () => void;
  refreshRepositoryStatus: (repoId: string) => void;
  retryDiff: () => void;
}

export function useCommitSubmission({
  getApi,
  repoId,
  message,
  selections,
  amend,
  signOff,
  sign,
  setSelections,
  appendTask,
  setTaskError,
  openTaskCenter,
  openPushTargetPicker,
  refreshRepositoryStatus,
  retryDiff,
}: CommitSubmissionOptions) {
  const [busy, setBusy] = useState(false);
  const taskContextsRef = useRef(new Map<string, CommitTaskContext>());

  async function submit(action: CommitAction, canCommit: boolean, target?: PushTarget) {
    const api = getApi();
    if (!api || !repoId || !canCommit) return;
    if (action === "commitAndPushTo" && !target) {
      openPushTargetPicker();
      return;
    }
    setBusy(true);
    setTaskError("");
    try {
      const task = await api.commitRepository(repoId, message, {
        amend,
        signOff,
        sign,
        ...(selections.length > 0 ? { selections } : {}),
      });
      appendTask(task);
      taskContextsRef.current.set(task.taskId, {
        selections: JSON.stringify(selections),
        message,
        intent: {
          action,
          ...(target ? { target } : {}),
          forceWithLease: action === "commitAndPushForce" || (action !== "commit" && amend),
        },
      });
      openTaskCenter();
    } catch (error) {
      if (error instanceof GitCrestApiError && error.body.error.code === "RESOURCE_VERSION_STALE") {
        setSelections([]);
        retryDiff();
        refreshRepositoryStatus(repoId);
      }
      setTaskError(describeApiError(error, t("err.commitStart")));
      openTaskCenter();
    } finally {
      setBusy(false);
    }
  }

  function takeTaskContext(taskId: string): CommitTaskContext | undefined {
    const context = taskContextsRef.current.get(taskId);
    taskContextsRef.current.delete(taskId);
    return context;
  }

  return { busy, submit, takeTaskContext };
}
