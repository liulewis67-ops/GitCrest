import { useState } from "react";
import {
  GitCrestApiError,
  type DiffDocumentResponse,
  type GitCrestApiClient,
  type RepositoryResponse,
  type StagingPatchRequest,
  type StagingRequest,
  type TaskSnapshotResponse,
} from "../../../api/client";

interface DiscardSelection {
  path: string;
  revision: string;
  selections: Array<{ hunkIndex: number; rowIndex?: number }>;
}

interface StagingOperationsOptions {
  getApi: () => GitCrestApiClient | undefined;
  repository?: RepositoryResponse;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  hasActiveStagingTask: boolean;
  document?: DiffDocumentResponse;
  discardSelection?: DiscardSelection;
  clearDiscardSelection: () => void;
  appendTask: (task: TaskSnapshotResponse) => void;
  prependTask: (task: TaskSnapshotResponse) => void;
  setTaskError: (message: string) => void;
  openTaskCenter: () => void;
}

export function useStagingOperations({
  getApi,
  repository,
  connected,
  hasActiveRepositoryTask,
  hasActiveStagingTask,
  document,
  discardSelection,
  clearDiscardSelection,
  appendTask,
  prependTask,
  setTaskError,
  openTaskCenter,
}: StagingOperationsOptions) {
  const [busy, setBusy] = useState(false);

  async function stageChanges(action: StagingRequest["action"], path?: string) {
    const api = getApi();
    const repoId = repository?.repoId;
    if (!api || !repoId || busy || hasActiveStagingTask) return;
    setBusy(true);
    setTaskError("");
    try {
      const request: StagingRequest = { action, ...(path ? { path } : {}) };
      appendTask(await api.stageRepositoryChanges(repoId, request));
      openTaskCenter();
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setTaskError(message || (error instanceof Error ? error.message : "Could not start the staging task."));
      openTaskCenter();
    } finally {
      setBusy(false);
    }
  }

  async function undoRecentOperation() {
    const api = getApi();
    if (!api || !repository || !connected || repository.availability !== "available" || hasActiveRepositoryTask) return;
    setTaskError("");
    try {
      prependTask(await api.undoRecentOperation(repository.repoId));
      openTaskCenter();
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setTaskError(message || (error instanceof Error ? error.message : "Could not undo the recent staging operation."));
      openTaskCenter();
    }
  }

  async function stageSelectedChanges(selections: Array<{ hunkIndex: number; rowIndex?: number }>) {
    const api = getApi();
    if (!api || !repository || !document || document.scope === "commit" || busy || hasActiveStagingTask) return;
    setBusy(true);
    setTaskError("");
    try {
      const request: StagingPatchRequest = {
        action: document.scope === "index" ? "unstage" : "stage",
        path: document.path,
        scope: document.scope,
        revision: document.revision,
        selections,
      };
      appendTask(await api.stageSelectedDiffHunks(repository.repoId, request));
      openTaskCenter();
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setTaskError(message || (error instanceof Error ? error.message : "Could not start the partial staging task."));
      openTaskCenter();
    } finally {
      setBusy(false);
    }
  }

  async function discardSelectedChanges() {
    const api = getApi();
    if (!api || !repository || !discardSelection || busy || hasActiveRepositoryTask) return;
    setBusy(true);
    setTaskError("");
    try {
      prependTask(await api.discardSelectedDiffChanges(repository.repoId, { ...discardSelection, confirmDiscard: true }));
      openTaskCenter();
      clearDiscardSelection();
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setTaskError(message || (error instanceof Error ? error.message : "Could not start the discard task."));
    } finally {
      setBusy(false);
    }
  }

  return { busy, stageChanges, stageSelectedChanges, undoRecentOperation, discardSelectedChanges };
}
