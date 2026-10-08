import { useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse } from "../../../api/client";

export interface CloneDraft {
  remoteUrl: string;
  parentPath: string;
  directoryName: string;
}

interface CloneSubmissionOptions {
  getApi: () => GitCrestApiClient | undefined;
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
}

export function useCloneSubmission({ getApi, onTaskAccepted }: CloneSubmissionOptions) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<CloneDraft>({ remoteUrl: "", parentPath: "", directoryName: "" });

  async function submit(remoteUrl: string, parentPath: string, directoryName: string) {
    const api = getApi();
    if (!api) return;
    setBusy(true);
    setError("");
    setDraft({ remoteUrl, parentPath, directoryName });
    try {
      onTaskAccepted(await api.cloneRepository(remoteUrl, parentPath, directoryName));
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

  return { busy, error, draft, submit, prepareRetry, clearError: () => setError("") };
}
