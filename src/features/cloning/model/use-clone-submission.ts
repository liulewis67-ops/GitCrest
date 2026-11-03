import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import {
  type GitCrestApiClient,
  type RepositoryResponse,
  type TaskSnapshotResponse,
} from "../../../api/client";

export interface CloneDraft {
  remoteUrl: string;
  parentPath: string;
  directoryName: string;
}

interface CloneSubmissionOptions {
  tasks: TaskSnapshotResponse[];
  getApi: () => GitCrestApiClient | undefined;
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
  onRepositoryOpened: (repository: RepositoryResponse) => void;
  closeTaskCenter: () => void;
  clearTaskError: () => void;
  setTaskError: (message: DisplayError) => void;
}

export function useCloneSubmission({
  tasks,
  getApi,
  onTaskAccepted,
  onRepositoryOpened,
  closeTaskCenter,
  clearTaskError,
  setTaskError,
}: CloneSubmissionOptions) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<CloneDraft>({ remoteUrl: "", parentPath: "", directoryName: "" });
  const cloneTaskIdsRef = useRef(new Set<string>());
  const openedTaskIdsRef = useRef(new Set<string>());
  const openClonedRepositoryRef = useRef<((task: TaskSnapshotResponse) => Promise<void>) | undefined>(undefined);

  async function submit(remoteUrl: string, parentPath: string, directoryName: string) {
    const api = getApi();
    if (!api) return;
    setBusy(true);
    setError("");
    setDraft({ remoteUrl, parentPath, directoryName });
    try {
      const task = await api.cloneRepository(remoteUrl, parentPath, directoryName);
      cloneTaskIdsRef.current.add(task.taskId);
      onTaskAccepted(task);
      closeDialog();
    } catch (requestError) {
      setError(describeApiError(requestError, t("err.cloneStart")));
    } finally {
      setBusy(false);
    }
  }

  function prepareRetry(targetPath?: string | null) {
    if (targetPath) {
      const separator = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
      setDraft((current) => ({ ...current, parentPath: targetPath.slice(0, separator), directoryName: targetPath.slice(separator + 1) }));
    }
    setError("");
  }

  function retryFromTask(task: TaskSnapshotResponse) {
    if (task.operation !== "clone" || (task.status !== "failed" && task.status !== "cancelled")) return;
    prepareRetry(task.targetPath);
    closeTaskCenter();
    openDialog();
  }

  /** Closes the dialog but keeps what was typed, so it reopens unchanged. */
  function stashDraft(next: CloneDraft) {
    setDraft(next);
    setDialogOpen(false);
  }

  function openDialog() {
    setError("");
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
  }

  async function openClonedRepository(task: TaskSnapshotResponse) {
    if (!cloneTaskIdsRef.current.has(task.taskId)
      || task.operation !== "clone"
      || task.status !== "succeeded"
      || !task.resultRepoId
      || openedTaskIdsRef.current.has(task.taskId)) return;
    openedTaskIdsRef.current.add(task.taskId);
    const api = getApi();
    if (!api) return;
    try {
      const repository = await api.getRepository(task.resultRepoId);
      onRepositoryOpened(repository);
      closeDialog();
      closeTaskCenter();
      clearTaskError();
    } catch (error) {
      openedTaskIdsRef.current.delete(task.taskId);
      setTaskError(describeApiError(error, "Clone completed, but the repository could not be opened."));
    }
  }

  openClonedRepositoryRef.current = openClonedRepository;
  useEffect(() => {
    for (const task of tasks) void openClonedRepositoryRef.current?.(task);
  }, [tasks]);

  return { busy, error, draft, dialogOpen, submit, prepareRetry, retryFromTask, stashDraft, openDialog, closeDialog };
}
