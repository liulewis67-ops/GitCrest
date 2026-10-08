import { useRef, useState } from "react";
import {
  GitCrestApiError,
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
  getApi: () => GitCrestApiClient | undefined;
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
  onRepositoryOpened: (repository: RepositoryResponse) => void;
  closeCloneDialog: () => void;
  closeTaskCenter: () => void;
  clearTaskError: () => void;
  setTaskError: (message: string) => void;
  openTaskCenter: () => void;
}

export function useCloneSubmission({
  getApi,
  onTaskAccepted,
  onRepositoryOpened,
  closeCloneDialog,
  closeTaskCenter,
  clearTaskError,
  setTaskError,
  openTaskCenter,
}: CloneSubmissionOptions) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<CloneDraft>({ remoteUrl: "", parentPath: "", directoryName: "" });
  const cloneTaskIdsRef = useRef(new Set<string>());
  const openedTaskIdsRef = useRef(new Set<string>());

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
    } catch (requestError) {
      const message = requestError instanceof GitCrestApiError ? requestError.body.error.message : undefined;
      setError(message || (requestError instanceof Error ? requestError.message : "Could not start the clone task."));
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
      closeCloneDialog();
      closeTaskCenter();
      clearTaskError();
    } catch (error) {
      openedTaskIdsRef.current.delete(task.taskId);
      setTaskError(error instanceof Error ? error.message : "Clone completed, but the repository could not be opened.");
      openTaskCenter();
    }
  }

  return { busy, error, draft, submit, prepareRetry, openClonedRepository, clearError: () => setError("") };
}
